import type { AgentesModule, Edition, ModuleContext } from "@agenteschat/modules";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import { apiError, domainErrorResponse, validationHook } from "./http/errors";
import { createLogger, type Logger } from "./logger";
import { accountRoutes } from "./routes/app/account";
import { agentRoutes } from "./routes/app/agents";
import { approvalRoutes } from "./routes/app/approvals";
import { channelRoutes } from "./routes/app/channels";
import { chatRoutes } from "./routes/app/chat";
import { connectorRoutes } from "./routes/app/connectors";
import type { AppDeps } from "./routes/app/context";
import { managementRoutes } from "./routes/app/management";
import { registerHealth } from "./routes/health";

export interface AppOptions {
  edition: Edition;
  version: string;
  modules: AgentesModule[];
  pingDatabase: () => Promise<void>;
  /** Needed when modules register routes. */
  moduleContext?: ModuleContext;
  /** Database, auth and adapters. Without them only system routes are mounted (some tests). */
  services?: AppDeps;
  /** Directory with the built web app (Vite SPA). Skipped when absent. */
  webDir?: string;
  log?: Logger;
}

/**
 * Builds the HTTP app without starting a server, so tests can call
 * `app.request(...)` directly. The WebSocket endpoint lives next to it in
 * `Bun.serve` (see `start.ts` and `realtime/ws.ts`).
 *
 * Layout:
 * - `/api/health`         health probe
 * - `/api/auth/*`         Better Auth (sign-up, sign-in, sessions, OAuth callbacks)
 * - `/api/app/*`          private API of the web app (cookie session + CSRF)
 * - `/api/ws`             WebSocket (real-time)
 * - `/api/openapi.json`   OpenAPI 3.1 document; `/api/reference` interactive docs
 * - everything else       web app (single-page app), when built
 */
export function createApp(options: AppOptions) {
  const log = options.log ?? createLogger("warn");
  const api = new OpenAPIHono({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Session cookie set by `/api/auth/sign-in/*`.",
  });

  registerHealth(api, {
    version: options.version,
    edition: options.edition,
    modules: options.modules.map((m) => m.name),
    pingDatabase: options.pingDatabase,
  });

  if (options.services) {
    const { auth } = options.services;
    api.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
    const deps = options.services;
    api.route("/app", accountRoutes(deps));
    api.route("/app", agentRoutes(deps));
    api.route("/app", chatRoutes(deps));
    api.route("/app", channelRoutes(deps));
    api.route("/app", approvalRoutes(deps));
    api.route("/app", connectorRoutes(deps));
    api.route("/app", managementRoutes(deps));
  }

  for (const module of options.modules) {
    if (!module.registerRoutes) continue;
    if (!options.moduleContext) throw new Error(`module ${module.name} needs a moduleContext`);
    module.registerRoutes(api, options.moduleContext);
  }

  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat API",
      version: options.version,
      description: "Workspace where people and AI agents work together.",
    },
  });
  api.get("/reference", Scalar({ url: "/api/openapi.json", pageTitle: "agentes.chat API" }));

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    log.error("unhandled error", { method: c.req.method, path: c.req.path, error: String(error), stack: error.stack });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route("/api", api);
  app.notFound((c) =>
    c.req.path.startsWith("/api/") ? apiError(c, 404, "not_found", "Route not found") : c.text("Not found", 404),
  );

  if (options.webDir) {
    const assets = serveStatic({ root: options.webDir });
    // Client-side routing: unknown non-API paths render the web app.
    const spa = serveStatic({ root: options.webDir, path: "index.html" });
    const isApi = (path: string) => path.startsWith("/api/");
    app.use("/*", (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
    app.get("/*", (c, next) => (isApi(c.req.path) ? next() : spa(c, next)));
  }

  return app;
}
