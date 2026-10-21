import type { AgentesModule, Edition, ModuleContext } from "@agenteschat/modules";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { serveStatic } from "hono/bun";
import { apiError, domainErrorResponse, validationHook } from "./http/errors";
import { createLogger, type Logger } from "./logger";
import { accessRoutes } from "./routes/app/access";
import { accountRoutes } from "./routes/app/account";
import { actionRoutes } from "./routes/app/actions";
import { agentImportRoutes } from "./routes/app/agent-imports";
import { agentRoutes } from "./routes/app/agents";
import { approvalRoutes } from "./routes/app/approvals";
import { artifactRoutes } from "./routes/app/artifacts";
import { browserRoutes } from "./routes/app/browser";
import { calendarRoutes } from "./routes/app/calendar";
import { channelRoutes } from "./routes/app/channels";
import { chatRoutes } from "./routes/app/chat";
import { connectorRoutes } from "./routes/app/connectors";
import { customConnectorRoutes } from "./routes/app/connectors-custom";
import type { AppDeps } from "./routes/app/context";
import { databaseRoutes } from "./routes/app/databases";
import { dmRoutes } from "./routes/app/dms";
import { forumRoutes } from "./routes/app/forum";
import { inviteRoutes } from "./routes/app/invites";
import { issueRoutes } from "./routes/app/issues";
import { knowledgeRoutes } from "./routes/app/knowledge";
import { machineAccountRoutes } from "./routes/app/machine-accounts";
import { mailRoutes } from "./routes/app/mail";
import { managementRoutes } from "./routes/app/management";
import { memoryRoutes } from "./routes/app/memory";
import { missionRoutes } from "./routes/app/missions";
import { notificationRoutes } from "./routes/app/notifications";
import { pushRoutes } from "./routes/app/push";
import { questionRoutes } from "./routes/app/questions";
import { routineRoutes } from "./routes/app/routines";
import { sandboxRoutes } from "./routes/app/sandboxes";
import { secretRoutes } from "./routes/app/secrets";
import { skillRoutes } from "./routes/app/skills";
import { storageRoutes } from "./routes/app/storage";
import { threadRoutes } from "./routes/app/threads";
import { wikiRoutes } from "./routes/app/wiki";
import { createDesktopReleases, registerDesktopRoutes } from "./routes/desktop";
import { registerGitProxy } from "./routes/git";
import { githubAppRoutes, registerGitHubAppWebhook } from "./routes/github-app";
import { registerHealth } from "./routes/health";
import { machineAppRoutes, registerMachinePublicRoutes } from "./routes/machines";
import { registerWaitlist } from "./routes/waitlist";
import { registerWebhookReceiver, webhookAdminRoutes } from "./routes/webhooks";

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
 * - `/api/app/*`          private API of the web and phone apps (cookie session + CSRF, ADR 0035)
 * - `/api/webhooks/*`     incoming webhooks (GitHub, Sentry), signature-checked
 * - `/api/github-app/webhook` our GitHub App's events (installs, suspensions), signature-checked
 * - `/api/git/*`          git proxy for agents' computers (their own credential, D35)
 * - `/api/machines/*`     connected computers' runner: device-code connection, uploads, install.sh (ADR 0025, 0036)
 * - `/api/desktop/*`      public: the desktop app's latest build and its download (ADR 0036)
 * - `/api/waitlist`       public: join the waiting list and confirm the email (landing page, only with LANDING_PAGE)
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
    api.route("/app", accessRoutes(deps));
    api.route("/app", agentRoutes(deps));
    api.route("/app", chatRoutes(deps));
    api.route("/app", actionRoutes(deps));
    api.route("/app", channelRoutes(deps));
    api.route("/app", approvalRoutes(deps));
    api.route("/app", customConnectorRoutes(deps));
    api.route("/app", connectorRoutes(deps));
    api.route("/app", mailRoutes(deps));
    api.route("/app", databaseRoutes(deps));
    api.route("/app", managementRoutes(deps));
    api.route("/app", knowledgeRoutes(deps));
    api.route("/app", memoryRoutes(deps));
    api.route("/app", dmRoutes(deps));
    api.route("/app", questionRoutes(deps));
    api.route("/app", browserRoutes(deps));
    api.route("/app", notificationRoutes(deps));
    api.route("/app", pushRoutes(deps));
    api.route("/app", secretRoutes(deps));
    api.route("/app", inviteRoutes(deps));
    api.route("/app", storageRoutes(deps));
    api.route("/app", artifactRoutes(deps));
    api.route("/app", issueRoutes(deps));
    api.route("/app", forumRoutes(deps));
    api.route("/app", threadRoutes(deps));
    api.route("/app", missionRoutes(deps));
    api.route("/app", wikiRoutes(deps));
    api.route("/app", routineRoutes(deps));
    api.route("/app", calendarRoutes(deps));
    api.route("/app", skillRoutes(deps));
    api.route("/app", agentImportRoutes(deps));
    api.route("/app", sandboxRoutes(deps));
    api.route("/app", machineAppRoutes(deps));
    api.route("/app", machineAccountRoutes(deps));
    api.route("/app", webhookAdminRoutes(deps));
    api.route("/app", githubAppRoutes(deps));
    registerWebhookReceiver(api, deps);
    registerGitHubAppWebhook(api, deps);
    registerMachinePublicRoutes(api, deps);
    registerDesktopRoutes(
      api,
      deps,
      createDesktopReleases({
        token: deps.config.DESKTOP_RELEASES_TOKEN,
        repo: deps.config.DESKTOP_RELEASES_REPO,
        publicUrl: deps.config.PUBLIC_URL,
        fetch: deps.extras?.desktopFetch,
      }),
    );
    if (deps.config.LANDING_PAGE) registerWaitlist(api, deps);
    if (deps.extras?.gitProxy) registerGitProxy(api, deps.extras.gitProxy);
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
    // The runner bundle (ADR 0025): always revalidated, JavaScript, and never the SPA when missing.
    app.get("/runner/*", async (c) => {
      const res = await assets(c, async () => {});
      if (!res) return c.text("Not found", 404);
      res.headers.set("cache-control", "no-cache");
      if (c.req.path.endsWith(".mjs")) res.headers.set("content-type", "text/javascript; charset=utf-8");
      return res;
    });
    app.use("/*", (c, next) => (isApi(c.req.path) ? next() : assets(c, next)));
    app.get("/*", (c, next) => (isApi(c.req.path) ? next() : spa(c, next)));
  }

  return app;
}
