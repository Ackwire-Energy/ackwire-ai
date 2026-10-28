import { connectorOAuthApps } from "@agenteschat/config";
import {
  acceptCustomSuggestion,
  appOAuthRedirect,
  BUILTIN_SCOPES,
  type ConnectorDeps,
  completeOAuth,
  connectionView,
  connectOverHttp,
  connectorGrantValidator,
  connectorListing,
  createApiKeyConnection,
  desktopOAuthRedirect,
  desktopReturnPath,
  getAgent,
  isAppReturn,
  isCustom,
  isDesktopReturn,
  listAgentScopes,
  listConnections,
  NotFoundError,
  peekOAuthState,
  presetForServer,
  requirePermission,
  revokeAtProvider,
  revokeConnection,
  setAgentScopes,
  startOAuth,
  syncCustomTools,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { sessionUser } from "../../auth";
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
    category: z.enum(["dev", "product", "docs", "data", "payments", "sales", "support", "marketing", "automation"]),
    auth: z.array(z.enum(["oauth", "api_key"])),
    oauthConfigured: z
      .boolean()
      .openapi({ description: "Signs in with OAuth here: our OAuth app, or the vendor's MCP OAuth." }),
    available: z.boolean().openapi({ description: "Can be connected on this server." }),
    needsServerUrl: z.boolean(),
    serverUrl: z.string().nullable().openapi({ description: "The MCP endpoint (`remote_mcp`)." }),
    iconUrl: z.string().nullable().openapi({
      description:
        "Brand icon served by the web app, null for a monogram: `/connectors/…` has one color, drawn in `brandColor`, and `/brands/…` keeps its maker's colors.",
    }),
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
  app.use("/organizations/*", requireSession(deps.auth));
  // The OAuth callback is a browser navigation: from the web app it carries our session; from the phone app
  // (the system browser) it doesn't, and it only hands the code back to the app (see the callback).
  const session = requireSession(deps.auth);
  app.use("/connectors/*", (c, next) =>
    c.req.path.endsWith("/connectors/oauth/callback") ? next() : session(c, next),
  );
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
            returnTo: z.string().max(500).optional().openapi({
              description:
                'Path to land on afterwards; "app:connectors" from the phone app, "desktop:" + the path from the desktop app\'s window (the callback hands the code back to the app, which finishes with `oauth/complete`).',
            }),
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
      // Started by the phone app: the system browser has no session of ours. Hand what the provider sent back
      // to the app, which finishes with its own session (the state stays bound to the person who started it).
      const started = q.state ? await peekOAuthState(connectorDeps, q.state) : null;
      if (started && isAppReturn(started.returnTo)) {
        if (q.error || !q.code) return c.redirect(appOAuthRedirect({ error: q.error ?? "missing_code" }), 302);
        return c.redirect(appOAuthRedirect({ state: q.state, code: q.code }), 302);
      }
      // Started in the desktop app's window: the browser the provider opened in isn't signed in either. The app
      // opens what the provider sent back in its window, which finishes with the window's session.
      if (started && isDesktopReturn(started.returnTo)) {
        const org = started.orgId;
        if (q.error || !q.code) return c.redirect(desktopOAuthRedirect({ org, error: q.error ?? "missing_code" }), 302);
        return c.redirect(desktopOAuthRedirect({ org, state: q.state, code: q.code }), 302);
      }
      if (q.error || !q.state || !q.code) {
        return c.redirect(`${base}/?connector_error=${encodeURIComponent(q.error ?? "missing_code")}`, 302);
      }
      const user = c.get("user") ?? (await sessionUser(deps.auth, c.req.raw.headers));
      if (!user) return c.redirect(`${base}/?connector_error=sign_in`, 302);
      try {
        const { connection, returnTo } = await completeOAuth(connectorDeps, user, { state: q.state, code: q.code });
        await afterConnected(connection, user.id);
        const sep = returnTo.includes("?") ? "&" : "?";
        return c.redirect(`${base}${returnTo}${sep}connected=${encodeURIComponent(connection.connector)}`, 302);
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        return c.redirect(`${base}/?connector_error=${encodeURIComponent(message)}`, 302);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/oauth/complete",
      tags,
      security,
      summary: "Finish an OAuth connection the phone app or the desktop app started (admins)",
      description:
        'The phone app opened the authorize URL in the system browser (`returnTo: "app:connectors"`), or the desktop app\'s window did (`returnTo: "desktop:"` + a path); the callback handed `state` and `code` back to the app, which sends them here with its own session. The state must be this person\'s and this organization\'s, unused and not expired. `returnTo`: the path a desktop authorization lands on.',
      request: {
        params: OrgParams,
        body: body(z.object({ state: z.string().min(1).max(200), code: z.string().min(1).max(2000) })),
      },
      responses: {
        200: json(z.object({ connectionId: z.uuid(), connector: z.string(), returnTo: z.string().optional() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const user = c.get("user");
      const started = await peekOAuthState(connectorDeps, input.state);
      // Another organization's (or an unknown) state reads as not found: nothing about it leaks.
      if (
        !started ||
        started.orgId !== orgId ||
        !(isAppReturn(started.returnTo) || isDesktopReturn(started.returnTo))
      ) {
        throw new NotFoundError("This authorization link is invalid or expired");
      }
      const { connection, returnTo } = await completeOAuth(connectorDeps, user, input);
      await afterConnected(connection, user.id);
      const landing = isDesktopReturn(returnTo) ? { returnTo: desktopReturnPath(returnTo) } : {};
      return c.json({ connectionId: connection.id, connector: connection.connector, ...landing }, 200);
    },
  );

  /** A server connected by address: its tools are read; a one-click one gets our classification right away. */
  async function afterConnected(connection: Awaited<ReturnType<typeof completeOAuth>>["connection"], userId: string) {
    if (!isCustom(connection)) return;
    const connect = deps.extras?.mcpConnect ?? connectOverHttp;
    const judge = deps.extras?.context?.judge;
    await syncCustomTools({ ...connectorDeps, connect, judge, blobs: adapters.platformBlobs }, connection).catch(
      () => {},
    );
    if (presetForServer(connection.serverUrl)) {
      await acceptCustomSuggestion({ ...connectorDeps, connect }, userId, connection.orgId, connection.id).catch(
        () => {},
      );
    }
  }

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
