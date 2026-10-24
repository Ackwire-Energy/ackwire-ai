import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { safeEqual } from "@agenteschat/engine";
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiError, domainErrorResponse, validationHook } from "../http/errors";
import type { Logger } from "../logger";
import { registerOperatorEvents } from "./events";
import { registerOperatorOrgs } from "./orgs";

/** Versioned because its caller deploys apart from this server (ADR 0056 §3). */
export const OPERATOR_API_PREFIX = "/api/operator/v1";

export interface OperatorDeps {
  db: Database;
  config: Config;
  version: string;
  log: Logger;
}

/**
 * The operator API (ADR 0056): what the people who run this instance need from their own services,
 * behind one bearer token. Served only by its own listener (`serveOperatorApi`), never by `createApp`.
 */
export function createOperatorApp(deps: OperatorDeps, token: string) {
  const api = new OpenAPIHono({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "operator", {
    type: "http",
    scheme: "bearer",
    description: "This server's `OPERATOR_API_TOKEN`.",
  });
  // Every path under the prefix, unknown ones and the document included, so nothing answers without it.
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!safeEqual(header.startsWith("Bearer ") ? header.slice(7).trim() : "", token)) {
      return apiError(c, 401, "unauthorized", "Missing or wrong operator token");
    }
    await next();
  });
  registerOperatorOrgs(api, deps);
  registerOperatorEvents(api, deps);
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat operator API",
      version: deps.version,
      description:
        "Workspace and account lookups, the events feed and review blocks, for the people who run this instance (ADR 0056).",
    },
    servers: [{ url: OPERATOR_API_PREFIX }],
    security: [{ operator: [] }],
  });

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    deps.log.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      error: String(error),
      stack: error.stack,
    });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route(OPERATOR_API_PREFIX, api);
  app.notFound((c) => apiError(c, 404, "not_found", "Route not found"));
  return app;
}

/** The operator API's own listener, only when `OPERATOR_API_TOKEN` is set: without it nothing listens. */
export function serveOperatorApi(deps: OperatorDeps, port = deps.config.OPERATOR_API_PORT) {
  const token = deps.config.OPERATOR_API_TOKEN;
  if (!token) return null;
  const app = createOperatorApp(deps, token);
  return Bun.serve({ hostname: deps.config.HOST, port, fetch: (req) => app.fetch(req) });
}
