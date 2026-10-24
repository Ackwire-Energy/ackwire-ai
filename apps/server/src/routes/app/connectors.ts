import { connectorOAuthApps } from "@agenteschat/config";
import {
  acceptCustomSuggestion,
  BUILTIN_SCOPES,
  type ConnectorDeps,
  completeOAuth,
  connectionView,
  connectOverHttp,
  connectorGrantValidator,
  connectorListing,
  createApiKeyConnection,
  getAgent,
  isCustom,
  listAgentScopes,
  listConnections,
  NotFoundError,
  presetForServer,
  requirePermission,
  revokeAtProvider,
  revokeConnection,
  setAgentScopes,
  startOAuth,
  syncCustomTools,
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
    kind: z.enum(["catalog", "remote_mcp"]).openapi({
      description:
        "`catalog`: our connector with its own scopes; `remote_mcp`: a vendor's official MCP server (one click).",
    }),
    category: z.enum(["dev", "product", "docs", "payments", "support", "marketing", "automation"]),
    auth: z.array(z.enum(["oauth", "api_key"])),
    oauthConfigured: z
      .boolean()
      .openapi({ description: "Signs in with OAuth here: our OAuth app, or the vendor's MCP OAuth." }),
    available: z.boolean().openapi({ description: "Can be connected on this server." }),
    needsServerUrl: z.boolean(),
    serverUrl: z.string().nullable().openapi({ description: "The MCP endpoint (`remote_mcp`)." }),
    iconUrl: z.string().nullable().openapi({ description: "Brand icon served by the web app; null = a monogram." }),
    brandColor: z.string().nullable().openapi({ description: "Tint of the icon; null = the ink." }),
    scopes: z.array(ScopeInfo),
    tools: z.array(z.object({ name: z.string(), scope: z.string(), sensitive: z.boolean() })),
  })
  .openapi("Connector");

const Grant = z.object({ connectionId: z.uuid().nullable(), scope: z.string() }).openapi("ScopeGrant");

/**
 * Connectors in two layers (ADR 0016): the organization connects an MCP server once
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
    resolveHost: deps.extras?.resolveHost,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/connectors/catalog",
      tags,
      security,
      summary:
        "Connectors agentes.chat knows (ours and one-click MCP servers), their scopes and tools; plus built-in scopes",
      responses: {
        200: json(z.object({ connectors: z.array(CatalogEntry), builtinScopes: z.array(ScopeInfo) })),
        401: errors[401],
      },
    }),
    (c) =>
      c.json(
        {
          connectors: connectorListing(oauthApps),
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
      await requirePermission(db, c.get("user").id, orgId, "manage_connectors");
      await revokeAtProvider(connectorDeps, orgId, connectionId).catch(() => false);
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
        if (isCustom(connection)) {
          const connect = deps.extras?.mcpConnect ?? connectOverHttp;
          const judge = deps.extras?.context?.judge;
          await syncCustomTools({ ...connectorDeps, connect, judge }, connection).catch(() => {});
          // A one-click connector: its tools get our suggested classification right away.
          if (presetForServer(connection.serverUrl)) {
            await acceptCustomSuggestion(
              { ...connectorDeps, connect },
              c.get("user").id,
              connection.orgId,
              connection.id,
            ).catch(() => {});
          }
        }
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
