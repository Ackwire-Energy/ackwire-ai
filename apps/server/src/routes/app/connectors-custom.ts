import { connectorOAuthApps } from "@agenteschat/config";
import {
  acceptCustomSuggestion,
  type CustomDeps,
  connectCustomServer,
  connectOverHttp,
  listCustomServers,
  refreshCustomServer,
  revokeConnection,
  saveCustomTools,
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
const Access = z.enum(["read", "write", "approval"]);

const CustomServer = z
  .object({
    id: z.uuid(),
    serverUrl: z.string(),
    label: z.string(),
    authType: z.enum(["oauth", "api_key"]),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        readOnlyHint: z.boolean().nullable(),
        suggestedAccess: Access.nullable().openapi({ description: "Our suggestion until an admin decides." }),
        access: Access.nullable().openapi({ description: "Null = not classified yet: hidden from agents." }),
        label: z.string(),
        firstSeenAt: z.string(),
      }),
    ),
    reviewedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("CustomServer");

const ServerParams = OrgParams.extend({ serverId: z.uuid() });

/**
 * Custom MCP servers by URL (admins): MCP-native OAuth (discovery + dynamic
 * client registration + PKCE + resource) or an API key; tools stay hidden
 * until an admin classifies each as read, write or approval. Agents get
 * `custom:{serverId}:read` / `:write` scopes.
 */
export function customConnectorRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const custom: CustomDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    oauthApps: connectorOAuthApps(config),
    publicUrl: config.PUBLIC_URL,
    http: deps.extras?.http,
    resolveHost: deps.extras?.resolveHost,
    connect: deps.extras?.mcpConnect ?? connectOverHttp,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors/custom",
      tags,
      security,
      summary: "Custom MCP servers and their tools",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ servers: z.array(CustomServer) })), ...errors },
    }),
    async (c) => c.json({ servers: await listCustomServers(db, c.get("user").id, c.req.valid("param").orgId) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom",
      tags,
      security,
      summary: "Connect an https MCP server: connected, OAuth to finish, or an API key is needed",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            serverUrl: z.string().min(1).max(500),
            apiKey: z.string().max(2000).optional(),
            label: z.string().max(80).optional(),
            returnTo: z.string().max(500).optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.union([
            z.object({ status: z.literal("connected"), server: CustomServer }),
            z.object({ status: z.literal("oauth"), authorizeUrl: z.string() }),
            z.object({ status: z.literal("needs_key") }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const started = await connectCustomServer(
        custom,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(started, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/refresh",
      tags,
      security,
      summary: "List the server's tools again (new ones come back unclassified)",
      request: { params: ServerParams },
      responses: { 200: json(CustomServer), ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await refreshCustomServer(custom, c.get("user").id, orgId, serverId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/tools",
      tags,
      security,
      summary: "Save the label and the classification of each tool",
      request: {
        params: ServerParams,
        body: body(
          z.object({
            label: z.string().max(80),
            tools: z.array(z.object({ name: z.string(), access: Access, label: z.string().max(120) })).max(500),
          }),
        ),
      },
      responses: { 200: json(CustomServer), ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await saveCustomTools(custom, c.get("user").id, orgId, serverId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/custom/{serverId}/accept-suggestion",
      tags,
      security,
      summary: "Classify every pending tool as suggested, in one call; lists agents that could get access",
      request: { params: ServerParams },
      responses: {
        200: json(
          z.object({
            server: CustomServer,
            agentsWithoutAccess: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
            suggestedGrant: z.object({ connectors: z.record(z.string(), z.boolean()) }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      return c.json(await acceptCustomSuggestion(custom, c.get("user").id, orgId, serverId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/connectors/custom/{serverId}",
      tags,
      security,
      summary: "Disconnect a custom server (agents lose its scopes)",
      request: { params: ServerParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, serverId } = c.req.valid("param");
      await revokeConnection(db, c.get("user").id, orgId, serverId);
      return c.body(null, 204);
    },
  );

  return app;
}
