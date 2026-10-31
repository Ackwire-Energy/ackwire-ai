import { connectorOAuthApps } from "@agenteschat/config";
import {
  acceptCustomSuggestion,
  type CustomDeps,
  connectCustomServer,
  connectOverHttp,
  connectorIconFile,
  listCustomServers,
  MCP_PRESETS,
  mcpPreset,
  NotFoundError,
  refreshCustomServer,
  requirePermission,
  revokeConnection,
  saveCustomTools,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { imageFile } from "../../http/image-file";
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
/** An admin's decision: how the tool may be used, or `off` (never offered, not asked again). */
const Decision = z.enum(["read", "write", "approval", "off"]);

const CustomServer = z
  .object({
    id: z.uuid(),
    serverUrl: z.string(),
    label: z.string(),
    authType: z.enum(["oauth", "api_key"]),
    iconUrl: z
      .string()
      .nullable()
      .openapi({ description: "The server's own icon (`/api/app/connector-icons/…`); null = a monogram." }),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        readOnlyHint: z.boolean().nullable(),
        suggestedAccess: Access.nullable().openapi({ description: "Our suggestion until an admin decides." }),
        access: Decision.nullable().openapi({ description: "Null = not classified yet: hidden from agents." }),
        level: Decision.openapi({ description: "The decision, else the suggestion." }),
        suggestionSource: z.enum(["annotation", "verb", "preset", "judge", "judge_failed"]).nullable().openapi({
          description: "Where the suggestion came from: the server's hints, the name's verb, or the judge.",
        }),
        suggestionReason: z
          .string()
          .nullable()
          .openapi({ description: "Why, as a code the web translates (`spends_money`, `unknown`…)." }),
        sensitive: z.boolean().openapi({ description: "May only ask for approval or be off." }),
        pending: z
          .boolean()
          .openapi({ description: "The name couldn't decide it and no one confirmed the suggestion yet." }),
        off: z.boolean(),
        nameParts: z
          .object({ verb: z.string().nullable(), words: z.array(z.string()) })
          .openapi({ description: "The readable name's parts (verb and words, English); the web localizes them." }),
        subject: z.string().openapi({ description: "The resource it is about (from the name): tools group by it." }),
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
  app.use("/connector-icons/*", requireSession(deps.auth));
  const custom: CustomDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    oauthApps: connectorOAuthApps(config),
    publicUrl: config.PUBLIC_URL,
    http: deps.extras?.http,
    resolveHost: deps.extras?.resolveHost,
    connect: deps.extras?.mcpConnect ?? connectOverHttp,
    judge: deps.extras?.context?.judge,
    blobs: adapters.platformBlobs,
  };

  // A server's icon, for the org's members.
  app.get("/connector-icons/:orgId/:connectionId/:file", async (c) =>
    imageFile(
      await connectorIconFile(
        { db, blobs: adapters.platformBlobs },
        c.get("user").id,
        c.req.param("orgId"),
        c.req.param("connectionId"),
        c.req.param("file"),
      ),
    ),
  );

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
      description:
        "A new server is every agent's, whole (`connector:*`): its tools reach them once classified, and sensitive ones still ask for approval. The same address again updates the credentials in place and keeps the grants.",
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

  const Preset = z
    .object({ id: z.string(), label: z.string(), description: z.string(), icon: z.string(), serverUrl: z.string() })
    .openapi("McpPreset");
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/connectors/presets",
      tags,
      security,
      summary: "One-click connectors: official MCP servers with OAuth and dynamic registration",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ presets: z.array(Preset) })), ...errors },
    }),
    async (c) => {
      await requirePermission(db, c.get("user").id, c.req.valid("param").orgId, "read");
      return c.json({ presets: [...MCP_PRESETS] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/connectors/presets/{presetId}/connect",
      tags,
      security,
      summary: "Connect a one-click connector (admins): returns the OAuth URL to open",
      description:
        "After the OAuth, our suggested classification is applied to its tools (admins can change it). No app registration needed.",
      request: {
        params: OrgParams.extend({ presetId: z.string().max(60) }),
        body: body(z.object({ returnTo: z.string().max(500).optional() })),
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
      const { orgId, presetId } = c.req.valid("param");
      const preset = mcpPreset(presetId);
      if (!preset) throw new NotFoundError("Unknown connector");
      const started = await connectCustomServer(custom, c.get("user").id, orgId, {
        serverUrl: preset.serverUrl,
        label: preset.label,
        returnTo: c.req.valid("json").returnTo,
      });
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
      description:
        "Sensitive tools may only be `approval` or `off` (400 otherwise). `confirmed: false` applies a suggestion but leaves an ambiguous tool waiting for a decision.",
      request: {
        params: ServerParams,
        body: body(
          z.object({
            label: z.string().max(80),
            tools: z
              .array(
                z.object({
                  name: z.string(),
                  access: Decision,
                  label: z.string().max(120),
                  confirmed: z.boolean().optional(),
                }),
              )
              .max(1000),
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
