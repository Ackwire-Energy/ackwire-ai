import {
  agentDetail,
  agentView,
  audienceOf,
  availableProviders,
  cancelRun,
  canTalkTo,
  canViewCost,
  continueRun,
  getOrgSettings,
  getRun,
  INVITE_NOTE_MAX,
  inviteMany,
  listAgentChannels,
  listInvitationsWithStatus,
  listMembers,
  listRuns,
  makeDefaultCredential,
  memberPresence,
  memberStatus,
  orgOverview,
  pickerModels,
  queueInvitationEmail,
  requirePermission,
  resendInvitation,
  rotateCredential,
  runErrorDetail,
  STATUS_EMOJI_MAX,
  STATUS_TEXT_MAX,
  setAgentChannels,
  setInvitationRoles,
  setMyStatus,
  talksToAgents,
  updateMyProfile,
  updateOrgSettings,
  usageReport,
} from "@agenteschat/engine";
import { contextWindowOf, nanoUsdToUsd, PROVIDERS, pricesAt, usdToNanoUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, iso, json, OrgParams, requireSession, security } from "./context";
import { AgentAppearance, AgentAudience, Credential, ModelTier, ProviderId, Role } from "./schemas";

const usd = (nano: number | null) => (nano === null ? null : nanoUsdToUsd(nano));
const ModelId = z.string().max(100);

const Settings = z
  .object({
    name: z.string(),
    context: z
      .string()
      .openapi({ description: "Shared with every agent of the organization (start of every prompt)." }),
    defaultCredentialId: z
      .uuid()
      .nullable()
      .openapi({ description: "Legacy single default key (kept for compatibility). Prefer `defaultCredentialIds`." }),
    defaultCredentialIds: z.record(z.string(), z.uuid()).openapi({
      description: "Default key per provider (`{ anthropic, openai }`): agents without a key, router, summaries.",
    }),
    routerModel: z.string().nullable().openapi({ description: "Null = the deployment's ROUTER_MODEL." }),
    summaryModel: z.string().nullable().openapi({ description: "Null = the deployment's SUMMARY_MODEL." }),
    timezone: z.string().openapi({ example: "America/Sao_Paulo" }),
    teamSize: z.enum(["solo", "small", "medium", "large"]).nullable(),
    defaultAgentBudgetUsd: z.number().optional().openapi({
      description: "Monthly budget of every agent without its own. Admins only (absent for members).",
    }),
    actionCheck: z.boolean().openapi({
      description: "Agents check what the team already did before acting outside (ADR 0064). On by default.",
    }),
    autoModels: z.record(z.string(), z.partialRecord(ModelTier, z.string())).openapi({
      description:
        "Per provider, the models Automático picks per tier where the workspace chose its own (`{ openrouter: { small, medium, large } }`, ADR 0087); a tier left out is the provider's default.",
    }),
  })
  .openapi("OrgSettings");

/** A member as `viewerId` sees them: a hidden person is offline to everyone else (ADR 0084). */
const personView = (
  { availability, statusText, statusEmoji, statusUntil, ...m }: Awaited<ReturnType<typeof listMembers>>[number],
  online: Set<string>,
  viewerId: string,
) => {
  const presence = memberPresence({ availability }, online.has(m.userId), m.userId === viewerId);
  return {
    ...m,
    joinedAt: m.joinedAt.toISOString(),
    lastSeenAt: iso(m.lastSeenAt),
    online: presence === "online" || presence === "away" || presence === "busy",
    presence,
    status: memberStatus({ statusText, statusEmoji, statusUntil }),
    ...(m.userId === viewerId ? { availability } : {}),
  };
};

/** Settings as this person may see them: the default budget is money, so admins only. */
const settingsFor = (s: Awaited<ReturnType<typeof getOrgSettings>>, seesCost: boolean) => {
  const { defaultAgentBudgetNanoUsd, ...rest } = s;
  return seesCost ? { ...rest, defaultAgentBudgetUsd: nanoUsdToUsd(defaultAgentBudgetNanoUsd) } : rest;
};

const MemberStatus = z
  .object({
    text: z.string(),
    emoji: z.string().nullable(),
    until: z.string().nullable().openapi({ description: "When it clears itself; null = until changed." }),
  })
  .openapi("MemberStatus");

const Person = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    avatarUrl: z.string().nullable().openapi({ description: "The photo uploaded here; wins over `image`." }),
    role: Role,
    roleIds: z.array(z.string()).openapi({ description: "Their roles (`org_roles` ids), not `everyone`." }),
    joinedAt: z.string(),
    lastSeenAt: z.string().nullable(),
    online: z.boolean().openapi({ description: "Seen as connected: `presence` is online, away or busy." }),
    presence: z.enum(["online", "away", "busy", "hidden", "offline"]).openapi({
      description: "`hidden` only for yourself; everyone else sees a hidden person as `offline`.",
    }),
    status: MemberStatus.nullable().openapi({ description: "What the person wrote they are doing; null = nothing." }),
    availability: z.enum(["auto", "away", "busy", "hidden"]).optional().openapi({
      description: "Only on your own row: what you picked (your `presence` reads offline while you aren't connected).",
    }),
    handle: z.string().openapi({ description: "`@ana`: unique in the organization; mentions resolve by it." }),
    timezone: z
      .string()
      .openapi({ description: "The person's time zone (the organization's if they didn't pick one)." }),
  })
  .openapi("Person");

const InvitationWithStatus = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: Role,
    roleIds: z.array(z.string()),
    channelIds: z.array(z.string()).openapi({ description: "Channels it adds them to, besides #general (ADR 0089)." }),
    status: z.enum(["pending", "expired"]),
    expiresAt: z.string(),
    createdAt: z.string(),
    invitedBy: z.string().nullable().openapi({ description: "Who sent it (their name)." }),
    url: z.string().nullable().openapi({
      description:
        "Its link, the same one the email carries, to copy at any time (ADR 0089). Null for an invitation sent " +
        "before links could be shown again: sending it again gives it one.",
    }),
  })
  .openapi("InvitationWithStatus");

const AgentChannel = z.object({ id: z.uuid(), name: z.string(), autoReply: z.boolean() }).openapi("AgentChannel");

const AgentDetail = z
  .object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    role: z.string(),
    instructions: z.string(),
    model: z.string(),
    ownerUserId: z.string().nullable(),
    credentialId: z.uuid().nullable().openapi({ description: "Null = platform key (Cloud)." }),
    budgetUsedPercent: z
      .number()
      .openapi({ description: "This month's spend over its budget (its own, else the workspace default), in %." }),
    monthlyBudgetUsd: z.number().nullable().optional().openapi({
      description: "Admins only: its own budget; null = the workspace default (`defaultBudgetUsd`).",
    }),
    defaultBudgetUsd: z.number().optional().openapi({ description: "Admins only: the workspace default budget." }),
    tokensThisMonth: z.number(),
    runsThisMonth: z.number(),
    failuresThisMonth: z.number(),
    runsByDay: z
      .array(z.object({ day: z.number(), runs: z.number(), failed: z.number() }))
      .openapi({ description: "This month's runs and failures per day (UTC); only days with runs." }),
    pendingApprovals: z.number(),
    channels: z.array(AgentChannel),
    createdAt: z.string(),
    audience: AgentAudience,
    audienceMode: z.enum(["everyone", "people", "owner"]),
    canTalk: z.boolean(),
    appearance: AgentAppearance.nullable(),
  })
  .openapi("AgentDetail");

const Run = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid(),
    trigger: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    errorCode: z.string().optional().openapi({ description: "Stable code of `error` (translate with `errorParams`)." }),
    errorParams: z.record(z.string(), z.string()).optional(),
    what: z.string().openapi({ description: "Start of the message that started the run." }),
    turns: z.number(),
    inputTokens: z.number().openapi({ description: "Every input token, cache included." }),
    cachedTokens: z.number().openapi({ description: "How much of `inputTokens` was read from the prompt cache." }),
    outputTokens: z.number(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    repo: z.string().nullable().openapi({ description: "GitHub repository it worked in (owner/name)." }),
    deniedRepo: z
      .string()
      .nullable()
      .openapi({ description: "GitHub repository it was refused (not in the agent's repositories)." }),
  })
  .openapi("Run");

// Runs carry tokens, never money: owners who aren't admins read them too (admins see cost in the usage report).
const toRun = ({ costNanoUsd: _cost, ...r }: Awaited<ReturnType<typeof listRuns>>[number]) => ({
  ...r,
  ...runErrorDetail(r.error),
  createdAt: r.createdAt.toISOString(),
  finishedAt: iso(r.finishedAt),
});

/** A run step's data without its cost (`model_call` steps record it). */
const stepData = (data: Record<string, unknown>) => {
  const { costNanoUsd: _cost, ...rest } = data;
  return rest;
};

/** Management screens: settings, people, invitations, credential rotation, agent detail, runs and usage. */
export function managementRoutes(deps: AppDeps) {
  const { db, adapters, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });

  // ── Organization ──────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/settings",
      tags: ["Organization"],
      security,
      summary: "Organization settings and context",
      request: { params: OrgParams },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const settings = await getOrgSettings(db, actor, orgId);
      return c.json(settingsFor(settings, await canViewCost(db, actor, orgId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/settings",
      tags: ["Organization"],
      security,
      summary: "Change settings or the organization context (admins)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().trim().min(1).max(100).optional(),
            context: z.string().max(20_000).optional(),
            defaultCredentialId: z.uuid().nullable().optional(),
            defaultCredentialIds: z.partialRecord(ProviderId, z.uuid().nullable()).optional(),
            routerModel: ModelId.nullable().optional(),
            summaryModel: ModelId.nullable().optional(),
            timezone: z.string().max(64).optional(),
            teamSize: z.enum(["solo", "small", "medium", "large"]).nullable().optional(),
            defaultAgentBudgetUsd: z
              .number()
              .positive()
              .max(1_000_000)
              .optional()
              .openapi({ description: "Monthly budget of every agent without its own." }),
            actionCheck: z.boolean().optional(),
            autoModels: z.partialRecord(ProviderId, z.partialRecord(ModelTier, ModelId.nullable())).optional().openapi({
              description:
                "Per provider and tier, one of that provider's models; null puts the tier back on its default.",
            }),
          }),
        ),
      },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const { defaultAgentBudgetUsd, ...input } = c.req.valid("json");
      const settings = await updateOrgSettings(db, actor, orgId, {
        ...input,
        ...(defaultAgentBudgetUsd !== undefined
          ? { defaultAgentBudgetNanoUsd: usdToNanoUsd(defaultAgentBudgetUsd) }
          : {}),
      });
      return c.json(settingsFor(settings, await canViewCost(db, actor, orgId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/overview",
      tags: ["Organization"],
      security,
      summary: "Sidebar counts: people, agents, the workspace's budget use this month, approvals waiting for me",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            name: z.string(),
            role: Role,
            people: z.number(),
            agents: z.number(),
            budgetUsedPercent: z.number().openapi({
              description: "What the workspace's agents spent this month over the sum of their budgets, in %.",
            }),
            approvalsWaitingForMe: z.number(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await orgOverview(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  // ── People and invitations ────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/people",
      tags: ["Members"],
      security,
      summary: "Members with presence (online now, last seen)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ people: z.array(Person) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const online = new Set(await adapters.presence.online(orgId));
      const rows = await listMembers(db, orgId);
      return c.json({ people: rows.map((m) => personView(m, online, c.get("user").id)) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/me",
      tags: ["Members"],
      security,
      summary: "Change your handle or time zone in this organization",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            handle: z.string().max(40).optional(),
            timezone: z.string().max(64).nullable().optional().openapi({ description: "Null = the organization's." }),
          }),
        ),
      },
      responses: { 200: json(Person), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const me = await updateMyProfile(db, c.get("user").id, orgId, c.req.valid("json"));
      const online = new Set(await adapters.presence.online(orgId));
      return c.json(personView(me, online, me.userId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/me/status",
      tags: ["Members"],
      security,
      summary: "Set your availability (auto, away, busy, hidden) and what you are doing",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            availability: z.enum(["auto", "away", "busy", "hidden"]).optional().openapi({
              description: "`auto` = online while connected; `hidden` = everyone else sees you offline.",
            }),
            status: z
              .object({
                text: z.string().max(STATUS_TEXT_MAX * 2),
                emoji: z.string().max(STATUS_EMOJI_MAX).nullable().optional(),
                until: z.string().nullable().optional().openapi({ description: "ISO time it clears; null = never." }),
              })
              .nullable()
              .optional()
              .openapi({ description: "Null (or empty text) clears it." }),
          }),
        ),
      },
      responses: { 200: json(Person), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await setMyStatus({ db, pubsub: adapters.pubsub }, userId, orgId, c.req.valid("json"));
      const me = (await listMembers(db, orgId)).find((m) => m.userId === userId);
      if (!me) return c.json({ error: { code: "not_found", message: "Not a member" } }, 404);
      return c.json(personView(me, new Set(await adapters.presence.online(orgId)), userId), 200);
    },
  );

  const inviteUrl = (token: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`;

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/invitations/all",
      tags: ["Members"],
      security,
      summary: "Invitations not accepted yet, with status (pending or expired)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ invitations: z.array(InvitationWithStatus) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const rows = await listInvitationsWithStatus(db, c.get("user").id, orgId, new Date(), config.AGENTES_SECRET);
      return c.json(
        {
          invitations: rows.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            roleIds: i.roleIds,
            channelIds: i.channelIds,
            status: i.status,
            expiresAt: i.expiresAt.toISOString(),
            createdAt: i.createdAt.toISOString(),
            invitedBy: i.invitedBy,
            url: i.token ? inviteUrl(i.token) : null,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invitations/batch",
      tags: ["Members"],
      security,
      summary: "Invite several emails at once",
      description:
        "One outcome per email: `invites`, each address with its own roles (ADR 0089), or `emails`, all with " +
        "`roleIds`. `channelIds` and `note` go with every one. Only a hash of each token is stored (7-day expiry); " +
        "the link can be copied again from the list.",
      request: {
        params: OrgParams,
        body: body(
          z
            .object({
              emails: z.array(z.string().max(320)).min(1).max(100).optional(),
              invites: z
                .array(
                  z.object({
                    email: z.string().max(320),
                    roleIds: z.array(z.string().uuid()).max(50).optional(),
                  }),
                )
                .min(1)
                .max(100)
                .optional(),
              roleIds: z
                .array(z.string().uuid())
                .max(50)
                .optional()
                .openapi({ description: "Roles they get on accepting, below your own (ADR 0085)." }),
              channelIds: z
                .array(z.string().uuid())
                .max(20)
                .optional()
                .openapi({ description: "Channels they join on accepting, besides #general (ADR 0089)." }),
              note: z
                .string()
                .max(INVITE_NOTE_MAX)
                .optional()
                .openapi({ description: "Your words, in the invitation email (ADR 0089)." }),
            })
            .refine((b) => (b.emails?.length ?? 0) + (b.invites?.length ?? 0) > 0, {
              message: "Send `emails` or `invites`",
            }),
        ),
      },
      responses: {
        200: json(
          z.object({
            results: z.array(
              z.object({
                email: z.string(),
                status: z.enum(["invited", "already_member", "invalid_email", "already_invited"]),
                invitationId: z.uuid().optional(),
                url: z.string().optional(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const results = await inviteMany(db, c.get("user").id, orgId, {
        ...c.req.valid("json"),
        secret: config.AGENTES_SECRET,
      });
      for (const r of results) {
        if (r.status !== "invited") continue;
        await queueInvitationEmail(db, {
          orgId,
          invitationId: r.invitationId,
          email: r.email,
          role: "member",
          url: inviteUrl(r.token),
          inviterId: c.get("user").id,
        });
      }
      deps.wakeWorkers?.();
      return c.json(
        {
          results: results.map((r) =>
            r.status === "invited"
              ? { email: r.email, status: r.status, invitationId: r.invitationId, url: inviteUrl(r.token) }
              : { email: r.email, status: r.status, ...(r.invitationId ? { invitationId: r.invitationId } : {}) },
          ),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invitations/{invitationId}/resend",
      tags: ["Members"],
      security,
      summary: "Resend: the same link, a new 7-day expiry (ADR 0089)",
      description: "An invitation sent before links could be shown again gets a new link: the old one stops working.",
      request: { params: OrgParams.extend({ invitationId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, invitationId } = c.req.valid("param");
      const { invitation, token } = await resendInvitation(
        db,
        c.get("user").id,
        orgId,
        invitationId,
        new Date(),
        config.AGENTES_SECRET,
      );
      await queueInvitationEmail(db, {
        orgId,
        invitationId,
        email: invitation.email,
        role: invitation.role,
        url: inviteUrl(token),
        inviterId: c.get("user").id,
      });
      deps.wakeWorkers?.();
      return c.json({ url: inviteUrl(token), expiresAt: invitation.expiresAt.toISOString() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/invitations/{invitationId}",
      tags: ["Members"],
      security,
      summary: "Change the roles a pending invitation gives (ADR 0089): the same link, nothing is sent",
      request: {
        params: OrgParams.extend({ invitationId: z.uuid() }),
        body: body(z.object({ roleIds: z.array(z.string().uuid()).max(50) })),
      },
      responses: { 200: json(z.object({ roleIds: z.array(z.string()) })), ...errors },
    }),
    async (c) => {
      const { orgId, invitationId } = c.req.valid("param");
      const result = await setInvitationRoles(db, c.get("user").id, orgId, invitationId, c.req.valid("json").roleIds);
      return c.json(result, 200);
    },
  );

  // ── Credentials ───────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials/{credentialId}/rotate",
      tags: ["Agents"],
      security,
      summary: "Replace a provider key, keeping the same credential (agents keep using it)",
      request: {
        params: OrgParams.extend({ credentialId: z.uuid() }),
        body: body(
          z.object({
            apiKey: z.string().min(8).max(500),
            label: z.string().max(80).optional(),
            workspaceId: z.string().max(128).nullable().optional(),
            organization: z.string().max(128).nullable().optional(),
            project: z.string().max(128).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(Credential), ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      const row = await rotateCredential(
        db,
        adapters.keyWrapper,
        c.get("user").id,
        orgId,
        credentialId,
        c.req.valid("json"),
        { fetch: deps.extras?.http },
      );
      return c.json({ ...row, createdAt: row.createdAt.toISOString(), revokedAt: iso(row.revokedAt) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials/{credentialId}/make-default",
      tags: ["Agents"],
      security,
      summary: 'Make this key its provider\'s default for the workspace ("Make default")',
      request: { params: OrgParams.extend({ credentialId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(Credential), ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      const row = await makeDefaultCredential(db, c.get("user").id, orgId, credentialId);
      return c.json({ ...row, createdAt: row.createdAt.toISOString(), revokedAt: iso(row.revokedAt) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/credentials/platform",
      tags: ["Agents"],
      security,
      summary: "Whether this server offers a platform key (agents without their own key use it)",
      request: { params: OrgParams, query: z.object({ provider: z.string().default("anthropic") }) },
      responses: { 200: json(z.object({ available: z.boolean() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const { provider } = c.req.valid("query");
      const pc = adapters.platformCredentials;
      const available = pc.available
        ? await pc.available(orgId, provider)
        : (await pc.resolve(orgId, provider)) !== null;
      return c.json({ available }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/models",
      tags: ["Agents"],
      security,
      summary: "Models, with whether this workspace can use them (it has a key for the provider, or the platform does)",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            models: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                provider: z.string(),
                contextWindow: z.number().int().openapi({ description: "Its context window in tokens." }),
                available: z.boolean(),
                recommended: z.boolean().openapi({ description: "Suggested for new agents of an available provider." }),
                cheap: z.boolean(),
                inputUsdPerMTok: z.number(),
                outputUsdPerMTok: z.number(),
                pick: z.boolean().optional().openapi({
                  description:
                    "In OpenRouter's long list (ADR 0087): a good pick, shown first. Absent: a catalog model.",
                }),
                tier: ModelTier.optional().openapi({
                  description: "The size Automático uses it for on its provider's key, by default.",
                }),
              }),
            ),
            providers: z.array(
              z.object({ id: z.string(), label: z.string(), hasKey: z.boolean(), platform: z.boolean() }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const providerIds = Object.keys(PROVIDERS);
      const access = await availableProviders(db, orgId, adapters.platformCredentials, providerIds);
      const usable = (p: string) => Boolean(access.get(p)?.own || access.get(p)?.platform);
      return c.json(
        {
          models: (await pickerModels(db)).map(([id, m]) => ({
            id,
            label: m.label,
            provider: m.provider,
            contextWindow: contextWindowOf(id),
            available: usable(m.provider),
            recommended: usable(m.provider) && m.recommended === true,
            cheap: m.cheap === true,
            inputUsdPerMTok: pricesAt(m).input / 1000,
            outputUsdPerMTok: pricesAt(m).output / 1000,
            ...(m.pick !== undefined ? { pick: m.pick } : {}),
            ...(m.tier ? { tier: m.tier } : {}),
          })),
          providers: providerIds.map((id) => ({
            id,
            label: (PROVIDERS as Record<string, { label: string }>)[id]?.label ?? id,
            hasKey: access.get(id)?.own ?? false,
            platform: access.get(id)?.platform ?? false,
          })),
        },
        200,
      );
    },
  );

  // ── Agents ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags: ["Agents"],
      security,
      summary: "An agent with its budget use (%), runs and channels this month",
      request: { params: AgentParams },
      responses: { 200: json(AgentDetail), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const d = await agentDetail(db, c.get("user").id, orgId, agentId);
      const v = agentView(d.agent);
      const seesCost = await canViewCost(db, c.get("user").id, orgId);
      return c.json(
        {
          id: v.id,
          name: v.name,
          handle: v.handle,
          role: v.role,
          instructions: v.instructions,
          model: v.model,
          ownerUserId: v.ownerUserId,
          credentialId: d.agent.credentialId,
          budgetUsedPercent: d.month.budgetUsedPercent,
          ...(seesCost
            ? {
                monthlyBudgetUsd: usd(v.monthlyBudgetNanoUsd),
                defaultBudgetUsd: v.monthlyBudgetNanoUsd === null ? nanoUsdToUsd(d.month.budgetNanoUsd) : undefined,
              }
            : {}),
          tokensThisMonth: d.month.tokens,
          runsThisMonth: d.month.runs,
          failuresThisMonth: d.month.failures,
          runsByDay: d.month.byDay,
          pendingApprovals: d.pendingApprovals,
          audience: audienceOf(d.agent),
          audienceMode: d.agent.audienceMode,
          canTalk: canTalkTo(d.agent, c.get("user").id, await talksToAgents(db, orgId, c.get("user").id)),
          appearance: v.appearance,
          channels: d.channels,
          createdAt: v.createdAt.toISOString(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/channels",
      tags: ["Agents"],
      security,
      summary: "Where the agent works",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ channels: z.array(AgentChannel) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      return c.json({ channels: await listAgentChannels(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/channels",
      tags: ["Agents"],
      security,
      summary: "Set the agent's channels (and whether it answers without a mention in each)",
      request: {
        params: AgentParams,
        body: body(
          z.object({
            channels: z.array(z.object({ channelId: z.uuid(), autoReply: z.boolean().optional() })).max(500),
          }),
        ),
      },
      responses: { 200: json(z.object({ channels: z.array(AgentChannel) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const channels = await setAgentChannels(db, c.get("user").id, orgId, agentId, c.req.valid("json").channels);
      return c.json({ channels }, 200);
    },
  );

  // ── Runs and usage ────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/runs",
      tags: ["Usage"],
      security,
      summary: "Run history with tokens (admins; owners for their agents). Cost is in the usage report",
      request: {
        params: OrgParams,
        query: z.object({
          agentId: z.uuid().optional(),
          status: z
            .enum(["queued", "running", "waiting_approval", "waiting_input", "done", "failed", "canceled"])
            .optional(),
          before: z.iso.datetime().optional(),
          since: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(z.object({ runs: z.array(Run) })), ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const runs = await listRuns(db, c.get("user").id, c.req.valid("param").orgId, {
        agentId: q.agentId,
        status: q.status,
        before: q.before ? new Date(q.before) : undefined,
        since: q.since ? new Date(q.since) : undefined,
        limit: q.limit,
      });
      return c.json({ runs: runs.map(toRun) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/runs/{runId}",
      tags: ["Usage"],
      security,
      summary: "One run and its steps (context, model calls, tool calls, approvals, messages)",
      request: { params: OrgParams.extend({ runId: z.uuid() }) },
      responses: {
        200: json(
          z.object({
            run: Run,
            steps: z.array(
              z.object({
                seq: z.number(),
                kind: z.string(),
                data: z.record(z.string(), z.unknown()),
                createdAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, runId } = c.req.valid("param");
      const { run, steps } = await getRun(db, c.get("user").id, orgId, runId);
      if (!run) return c.json({ error: { code: "not_found", message: "Run not found" } }, 404);
      return c.json(
        {
          run: toRun(run),
          steps: steps.map((s) => ({ ...s, data: stepData(s.data), createdAt: s.createdAt.toISOString() })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/runs/{runId}/cancel",
      tags: ["Usage"],
      security,
      summary:
        "Stop an agent's run (the person who asked, the agent's owner or an admin). Its text so far is kept; a queued run never starts",
      request: { params: OrgParams.extend({ runId: z.uuid() }) },
      responses: {
        200: json(
          z.object({
            id: z.uuid(),
            status: z.literal("canceled"),
            previousStatus: z.enum(["queued", "running", "waiting_approval", "waiting_input"]),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, runId } = c.req.valid("param");
      const result = await cancelRun({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, runId);
      return c.json(
        {
          id: result.id,
          status: "canceled" as const,
          previousStatus: result.previousStatus as "queued" | "running" | "waiting_approval" | "waiting_input",
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/runs/{runId}/continue",
      tags: ["Usage"],
      security,
      summary:
        "Continue a run a person stopped (same people as stopping it): a new run of the agent picks up where it stopped",
      description:
        "Only for a run stopped by a person while it worked; once per stopped reply (`meta.canceled.continuedRunId`). 409 `run.not_continuable` otherwise, 409 `run.agent_busy` while the agent already works in that conversation. The channel hears `run.continued`.",
      request: { params: OrgParams.extend({ runId: z.uuid() }) },
      responses: { 200: json(z.object({ runId: z.uuid() })), ...errors },
    }),
    async (c) => {
      const { orgId, runId } = c.req.valid("param");
      const result = await continueRun({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, runId);
      // Wake the workers now instead of waiting for the poll.
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/report",
      tags: ["Usage"],
      security,
      summary: "Spend by kind (agent, router, embedding, summary) and per agent with budgets (admins)",
      request: { params: OrgParams, query: z.object({ since: z.iso.datetime().optional() }) },
      responses: {
        200: json(
          z.object({
            since: z.string(),
            defaultAgentBudgetUsd: z.number().openapi({ description: "Budget of agents without their own." }),
            totalUsd: z.number(),
            platformBilled: z
              .object({ calls: z.number(), costUsd: z.number() })
              .openapi({ description: "Calls the server pays for (Jev), not in the total." }),
            byKind: z.array(
              z.object({
                kind: z.enum(["agent", "router", "embedding", "summary"]),
                calls: z.number(),
                partialCalls: z.number(),
                inputTokens: z.number(),
                outputTokens: z.number(),
                costUsd: z.number(),
              }),
            ),
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                handle: z.string(),
                name: z.string(),
                calls: z.number(),
                inputTokens: z.number(),
                outputTokens: z.number(),
                costUsd: z.number(),
                monthlyBudgetUsd: z.number().openapi({ description: "Its effective budget (own or the default)." }),
                budgetIsDefault: z.boolean(),
                budgetUsedPercent: z.number(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const r = await usageReport(db, c.get("user").id, c.req.valid("param").orgId, {
        since: q.since ? new Date(q.since) : undefined,
      });
      return c.json(
        {
          since: r.since.toISOString(),
          defaultAgentBudgetUsd: nanoUsdToUsd(r.defaultAgentBudgetNanoUsd),
          totalUsd: nanoUsdToUsd(r.totalNanoUsd),
          platformBilled: { calls: r.platformBilled.calls, costUsd: nanoUsdToUsd(r.platformBilled.costNanoUsd) },
          byKind: r.byKind.map(({ costNanoUsd, ...k }) => ({ ...k, costUsd: nanoUsdToUsd(costNanoUsd) })),
          agents: r.agents.map(({ costNanoUsd, monthlyBudgetNanoUsd, ...a }) => ({
            ...a,
            costUsd: nanoUsdToUsd(costNanoUsd),
            monthlyBudgetUsd: nanoUsdToUsd(monthlyBudgetNanoUsd),
          })),
        },
        200,
      );
    },
  );

  return app;
}
