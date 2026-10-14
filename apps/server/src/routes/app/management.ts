import {
  agentDetail,
  agentView,
  getOrgSettings,
  getRun,
  inviteMany,
  listAgentChannels,
  listInvitationsWithStatus,
  listMembers,
  listRuns,
  orgOverview,
  queueInvitationEmail,
  requirePermission,
  resendInvitation,
  rotateCredential,
  setAgentChannels,
  updateOrgSettings,
  usageReport,
} from "@agenteschat/engine";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, iso, json, OrgParams, requireSession, security } from "./context";
import { Credential, Role } from "./schemas";

const usd = (nano: number | null) => (nano === null ? null : nanoUsdToUsd(nano));
const ModelId = z.string().max(100);

const Settings = z
  .object({
    name: z.string(),
    context: z
      .string()
      .openapi({ description: "Shared with every agent of the organization (start of every prompt)." }),
    defaultCredentialId: z.uuid().nullable().openapi({ description: "Key that pays for router and summaries." }),
    routerModel: z.string().nullable().openapi({ description: "Null = the deployment's ROUTER_MODEL." }),
    summaryModel: z.string().nullable().openapi({ description: "Null = the deployment's SUMMARY_MODEL." }),
    timezone: z.string().openapi({ example: "America/Sao_Paulo" }),
  })
  .openapi("OrgSettings");

const Person = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: Role,
    joinedAt: z.string(),
    lastSeenAt: z.string().nullable(),
    online: z.boolean(),
  })
  .openapi("Person");

const InvitationWithStatus = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: Role,
    status: z.enum(["pending", "expired"]),
    expiresAt: z.string(),
    createdAt: z.string(),
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
    monthlyBudgetUsd: z.number().nullable(),
    spentThisMonthUsd: z.number(),
    reservedUsd: z.number().openapi({ description: "Held for calls in flight." }),
    tokensThisMonth: z.number(),
    runsThisMonth: z.number(),
    pendingApprovals: z.number(),
    channels: z.array(AgentChannel),
    createdAt: z.string(),
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
    what: z.string().openapi({ description: "Start of the message that started the run." }),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .openapi("Run");

const toRun = (r: Awaited<ReturnType<typeof listRuns>>[number]) => ({
  ...r,
  costUsd: nanoUsdToUsd(r.costNanoUsd),
  costNanoUsd: undefined,
  createdAt: r.createdAt.toISOString(),
  finishedAt: iso(r.finishedAt),
});

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
    async (c) => c.json(await getOrgSettings(db, c.get("user").id, c.req.valid("param").orgId), 200),
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
            routerModel: ModelId.nullable().optional(),
            summaryModel: ModelId.nullable().optional(),
            timezone: z.string().max(64).optional(),
          }),
        ),
      },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) =>
      c.json(await updateOrgSettings(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/overview",
      tags: ["Organization"],
      security,
      summary: "Sidebar counts: people, agents, my agents' spend this month, approvals waiting for me",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            name: z.string(),
            role: Role,
            people: z.number(),
            agents: z.number(),
            myAgentsSpendUsd: z.number(),
            approvalsWaitingForMe: z.number(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const o = await orgOverview(db, c.get("user").id, c.req.valid("param").orgId);
      const { myAgentsSpendNanoUsd, ...rest } = o;
      return c.json({ ...rest, myAgentsSpendUsd: nanoUsdToUsd(myAgentsSpendNanoUsd) }, 200);
    },
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
      return c.json(
        {
          people: rows.map((m) => ({
            ...m,
            joinedAt: m.joinedAt.toISOString(),
            lastSeenAt: iso(m.lastSeenAt),
            online: online.has(m.userId),
          })),
        },
        200,
      );
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
      const rows = await listInvitationsWithStatus(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          invitations: rows.map((i) => ({
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            expiresAt: i.expiresAt.toISOString(),
            createdAt: i.createdAt.toISOString(),
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
        "One outcome per email. Links are returned once; only a hash of each token is stored (7-day expiry).",
      request: {
        params: OrgParams,
        body: body(z.object({ emails: z.array(z.string().max(320)).min(1).max(100), role: Role })),
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
      const results = await inviteMany(db, c.get("user").id, orgId, c.req.valid("json"));
      for (const r of results) {
        if (r.status !== "invited") continue;
        await queueInvitationEmail(db, {
          orgId,
          invitationId: r.invitationId,
          email: r.email,
          role: c.req.valid("json").role,
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
      summary: "Resend: new link (the old one stops working), new 7-day expiry",
      request: { params: OrgParams.extend({ invitationId: z.uuid() }), body: body(z.object({})) },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, invitationId } = c.req.valid("param");
      const { invitation, token } = await resendInvitation(db, c.get("user").id, orgId, invitationId);
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
      );
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

  // ── Agents ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags: ["Agents"],
      security,
      summary: "An agent with spend, runs and channels this month",
      request: { params: AgentParams },
      responses: { 200: json(AgentDetail), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const d = await agentDetail(db, c.get("user").id, orgId, agentId);
      const v = agentView(d.agent);
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
          monthlyBudgetUsd: usd(v.monthlyBudgetNanoUsd),
          spentThisMonthUsd: nanoUsdToUsd(d.month.spentNanoUsd),
          reservedUsd: nanoUsdToUsd(d.month.reservedNanoUsd),
          tokensThisMonth: d.month.tokens,
          runsThisMonth: d.month.runs,
          pendingApprovals: d.pendingApprovals,
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
      return c.json({ channels: await listAgentChannels(db, orgId, agentId) }, 200);
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
      summary: "Run history with tokens and cost (admins; owners for their agents)",
      request: {
        params: OrgParams,
        query: z.object({
          agentId: z.uuid().optional(),
          status: z.enum(["queued", "running", "waiting_approval", "done", "failed"]).optional(),
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
        { run: toRun(run), steps: steps.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/report",
      tags: ["Usage"],
      security,
      summary: "Spend by kind (agent, router, embedding, summary) and per agent with budgets",
      request: { params: OrgParams, query: z.object({ since: z.iso.datetime().optional() }) },
      responses: {
        200: json(
          z.object({
            since: z.string(),
            totalUsd: z.number(),
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
                monthlyBudgetUsd: z.number().nullable(),
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
          totalUsd: nanoUsdToUsd(r.totalNanoUsd),
          byKind: r.byKind.map(({ costNanoUsd, ...k }) => ({ ...k, costUsd: nanoUsdToUsd(costNanoUsd) })),
          agents: r.agents.map(({ costNanoUsd, monthlyBudgetNanoUsd, ...a }) => ({
            ...a,
            costUsd: nanoUsdToUsd(costNanoUsd),
            monthlyBudgetUsd: usd(monthlyBudgetNanoUsd),
          })),
        },
        200,
      );
    },
  );

  return app;
}
