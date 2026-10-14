import { connectorOAuthApps } from "@agenteschat/config";
import {
  BUILTIN_SCOPES,
  CONNECTOR_CATALOG,
  type ConnectorDeps,
  completeOAuth,
  connectionView,
  connectorGrantValidator,
  createApiKeyConnection,
  getAgent,
  listAgentScopes,
  listConnections,
  NotFoundError,
  requirePermission,
  revokeConnection,
  setAgentScopes,
  startOAuth,
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

const tags = ["Connectors"];

const Connection = z
  .object({
    id: z.uuid(),
    connector: z.string(),
    label: z.string(),
    serverUrl: z.string(),
    authType: z.string(),
    accountLabel: z.string().nullable(),
    tokenExpiresAt: z.string().nullable(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi("ConnectorConnection");

const ScopeInfo = z.object({ id: z.string(), label: z.string(), description: z.string(), sensitive: z.boolean() });

const CatalogEntry = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    auth: z.array(z.enum(["oauth", "api_key"])),
    oauthConfigured: z.boolean().openapi({ description: "This server has an OAuth app for it (else: API key only)." }),
    needsServerUrl: z.boolean(),
    scopes: z.array(ScopeInfo),
    tools: z.array(z.object({ name: z.string(), scope: z.string(), sensitive: z.boolean() })),
  })
  .openapi("Connector");

const Grant = z.object({ connectionId: z.uuid().nullable(), scope: z.string() }).openapi("ScopeGrant");

/**
 * Connectors in two layers (D7): the organization connects an MCP server once
 * (OAuth or API key, stored encrypted); each agent gets a subset of its
 * scopes. Also lists the built-in scopes.
 */
export function connectorRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  for (const path of ["/organizations/*", "/connectors/*"]) app.use(path, requireSession(deps.auth));
  const oauthApps = connectorOAuthApps(config);
  const connectorDeps: ConnectorDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    oauthApps,
    publicUrl: config.PUBLIC_URL,
    http: deps.extras?.http,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/catalog",
      tags,
      security,
      summary: "Connectors agentes.chat knows, their scopes and tools; plus built-in scopes",
      responses: {
        200: json(z.object({ connectors: z.array(CatalogEntry), builtinScopes: z.array(ScopeInfo) })),
        401: errors[401],
      },
    }),
    (c) =>
      c.json(
        {
          connectors: Object.values(CONNECTOR_CATALOG).map((d) => {
            const sensitiveScopes = new Set(Object.values(d.tools).flatMap((t) => (t.sensitive ? [t.scope] : [])));
            return {
              id: d.id,
              label: d.label,
              description: d.description,
              auth: d.auth,
              oauthConfigured: Boolean(d.oauth && oauthApps[d.id]),
              needsServerUrl: d.serverUrl === null,
              scopes: Object.entries(d.scopes).map(([id, s]) => ({
                id: `${d.id}:${id}`,
                label: s.label,
                description: s.description,
                sensitive: sensitiveScopes.has(id),
              })),
              tools: Object.entries(d.tools).map(([name, t]) => ({
                name,
                scope: `${d.id}:${t.scope}`,
                sensitive: t.sensitive === true,
              })),
            };
          }),
          builtinScopes: Object.entries(BUILTIN_SCOPES).map(([id, s]) => ({
            id,
            label: s.label,
            description: s.description,
            sensitive: s.sensitive === true,
          })),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors",
      tags,
      security,
      summary: "Connected MCP servers (no secrets)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ connections: z.array(Connection) })), ...errors },
    }),
    async (c) => {
      const rows = await listConnections(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ connections: rows.map(connectionView) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors",
      tags,
      security,
      summary: "Connect with an API key (admins)",
      description: "Replaces an existing connection of the same connector; agents keep their grants.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            connector: z.string(),
            apiKey: z.string().min(8).max(2000).optional(),
            serverUrl: z.url().optional(),
            label: z.string().max(80).optional(),
          }),
        ),
      },
      responses: { 201: json(Connection, "Created"), ...errors },
    }),
    async (c) => {
      const row = await createApiKeyConnection(
        connectorDeps,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(connectionView(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/connectors/{connectionId}",
      tags,
      security,
      summary: "Disconnect (agents lose its scopes)",
      request: { params: OrgParams.extend({ connectionId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      await revokeConnection(db, c.get("user").id, orgId, connectionId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/{connector}/oauth/start",
      tags,
      security,
      summary: "Start connecting over OAuth (admins); open the returned URL",
      request: {
        params: OrgParams.extend({ connector: z.string() }),
        body: body(
          z.object({
            returnTo: z.string().max(500).optional().openapi({ description: "Path to land on afterwards." }),
            serverUrl: z.url().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ authorizeUrl: z.string() })), ...errors },
    }),
    async (c) => {
      const { orgId, connector } = c.req.valid("param");
      const { authorizeUrl } = await startOAuth(connectorDeps, c.get("user").id, orgId, connector, c.req.valid("json"));
      return c.json({ authorizeUrl }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/oauth/callback",
      tags,
      security,
      summary: "OAuth redirect target (browser navigation)",
      description: "Validates state and PKCE, stores the tokens encrypted, then redirects to the web app.",
      request: {
        query: z.object({
          state: z.string().optional(),
          code: z.string().optional(),
          error: z.string().optional(),
        }),
      },
      responses: { 302: { description: "Back to the web app" }, ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const base = config.PUBLIC_URL.replace(/\/$/, "");
      if (q.error || !q.state || !q.code) {
        return c.redirect(`${base}/?connector_error=${encodeURIComponent(q.error ?? "missing_code")}`, 302);
      }
      try {
        const { connection, returnTo } = await completeOAuth(connectorDeps, c.get("user"), {
          state: q.state,
          code: q.code,
        });
        const sep = returnTo.includes("?") ? "&" : "?";
        return c.redirect(`${base}${returnTo}${sep}connected=${encodeURIComponent(connection.connector)}`, 302);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return c.redirect(`${base}/?connector_error=${encodeURIComponent(message)}`, 302);
      }
    },
  );

  // ── Agent permissions (layer 2) ───────────────────────────────────────────
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/scopes",
      tags,
      security,
      summary: "What an agent may do",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ scopes: z.array(Grant) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
      return c.json({ scopes: await listAgentScopes(db, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/scopes",
      tags,
      security,
      summary: "Replace an agent's scopes (admins)",
      description: "Only scopes from the built-in list or the connected connectors' catalogs can be granted.",
      request: { params: AgentParams, body: body(z.object({ scopes: z.array(Grant).max(200) })) },
      responses: { 200: json(z.object({ scopes: z.array(Grant) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await setAgentScopes(db, c.get("user").id, orgId, agentId, c.req.valid("json").scopes, connectorGrantValidator);
      return c.json({ scopes: await listAgentScopes(db, orgId, agentId) }, 200);
    },
  );

  return app;
}
