import {
  applyOrgNetwork,
  deleteAgentComputer,
  getAgentComputer,
  getSandboxSettings,
  NotFoundError,
  requirePermission,
  SANDBOX_LIMITS,
  startAgentComputer,
  stopAgentComputer,
  updateSandboxSettings,
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

const tags = ["Agent computer"];
const Computer = z
  .object({
    status: z
      .enum(["starting", "running", "stopping", "stopped", "archived", "error", "none"])
      .openapi({ description: "`none`: never created yet. Changes also come as `agent.computer` events." }),
    diskUsedGib: z.number().openapi({ description: "Size of the workspace, last measured while it ran." }),
    costMonthUsd: z.number(),
    createdAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    network: z
      .enum(["blocked", "allowlist", "open", "provider-default"])
      .optional()
      .openapi({ description: "`provider-default`: the provider's plan can't apply our domain list." }),
    error: z.object({ message: z.string() }).optional().openapi({ description: "With `status: error`." }),
  })
  .openapi("AgentComputer");
const Accepted = z
  .object({ status: z.enum(["starting", "running", "stopping", "stopped", "archived", "error", "none"]) })
  .openapi("ComputerAccepted");
const Settings = z
  .object({
    available: z.boolean().openapi({ description: "A sandbox provider is configured on this server." }),
    enabled: z.boolean(),
    network: z.enum(["blocked", "allowlist", "open"]).openapi({
      description:
        "`blocked`: no internet; `allowlist`: only `allowDomains`; `open`: full internet (still no secrets inside).",
    }),
    allowDomains: z.array(z.string()).openapi({ description: "Domains the computers may reach in `allowlist` mode." }),
    execTimeoutSeconds: z.number(),
    maxTimeoutSeconds: z.number(),
    dailyMinutes: z.number(),
    requireApproval: z.boolean(),
  })
  .openapi("SandboxSettings");
const AgentParams = OrgParams.extend({ agentId: z.uuid() });

/**
 * Each agent's computer (D30): status, start, stop and delete (the agent's
 * owner or admins), and the org's settings (on/off, allowed domains, limits).
 */
export function sandboxRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const sandbox = () => {
    const s = deps.extras?.sandbox;
    if (!s) throw new NotFoundError("Agent computers are not available on this server");
    return s;
  };
  const settingsView = async (orgId: string) => ({
    available: Boolean(deps.extras?.sandbox),
    ...(await getSandboxSettings(db, orgId)),
    maxTimeoutSeconds: SANDBOX_LIMITS.maxTimeoutSeconds,
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/computer",
      tags,
      security,
      summary: "The agent's computer (owner or admins)",
      request: { params: AgentParams },
      responses: { 200: json(Computer), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await getAgentComputer(sandbox(), c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/computer/start",
      tags,
      security,
      summary: "Turn it on (creates it the first time); returns at once, progress as `agent.computer` events",
      request: { params: AgentParams },
      responses: { 202: json(Accepted, "Accepted: the work goes on in the background"), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const deps2 = { ...sandbox(), pubsub: deps.adapters.pubsub };
      return c.json(await startAgentComputer(deps2, c.get("user").id, orgId, agentId), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/computer/stop",
      tags,
      security,
      summary: "Turn it off (files kept); returns at once",
      request: { params: AgentParams },
      responses: { 202: json(Accepted, "Accepted: the work goes on in the background"), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const deps2 = { ...sandbox(), pubsub: deps.adapters.pubsub };
      return c.json(await stopAgentComputer(deps2, c.get("user").id, orgId, agentId), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}/computer",
      tags,
      security,
      summary: "Delete it with all its files",
      request: { params: AgentParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await deleteAgentComputer({ ...sandbox(), pubsub: deps.adapters.pubsub }, c.get("user").id, orgId, agentId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/sandbox-settings",
      tags,
      security,
      summary: "Settings of the agents' computers in the organization",
      request: { params: OrgParams },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      return c.json(await settingsView(orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/sandbox-settings",
      tags,
      security,
      summary: "Change the computers' settings (admins): on/off, allowed domains, limits, approval",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            enabled: z.boolean().optional(),
            network: z.enum(["blocked", "allowlist", "open"]).optional(),
            allowDomains: z.array(z.string().max(253)).max(SANDBOX_LIMITS.maxAllowDomains).optional(),
            execTimeoutSeconds: z.number().int().min(5).max(SANDBOX_LIMITS.maxTimeoutSeconds).optional(),
            dailyMinutes: z.number().int().min(0).max(1440).optional(),
            requireApproval: z.boolean().optional(),
          }),
        ),
      },
      responses: {
        200: json(
          Settings.extend({
            networkApply: z.enum(["live", "next_start"]).openapi({
              description:
                "`live`: every computer has the new network now; `next_start`: some get it when they next start.",
            }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await updateSandboxSettings(db, c.get("user").id, orgId, c.req.valid("json"));
      // Running computers get the new network now; stopped ones when they next start.
      const applied = deps.extras?.sandbox
        ? await applyOrgNetwork(deps.extras.sandbox, orgId).catch(() => ({ applied: 0, later: 1 }))
        : { applied: 0, later: 0 };
      return c.json(
        { ...(await settingsView(orgId)), networkApply: applied.later > 0 ? "next_start" : "live" } as const,
        200,
      );
    },
  );

  return app;
}
