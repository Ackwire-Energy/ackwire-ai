import type { Adapters } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { type Auth, type SessionUser, sessionUser } from "../../auth";
import { apiError, errorResponse, validationHook } from "../../http/errors";
import type { AppExtras } from "./extras";

export interface AppDeps {
  db: Database;
  auth: Auth;
  config: Config;
  adapters: Adapters;
  /** Wakes the in-process workers after something was enqueued (lower latency than the poll interval). */
  wakeWorkers?: () => void;
  /** Backend services (see `extras.ts`). */
  extras?: AppExtras;
}

export type AppEnv = { Variables: { user: SessionUser } };

/** Allowed browser origins for state-changing requests and WebSocket upgrades. */
export function allowedOrigins(config: Config): Set<string> {
  return new Set([
    new URL(config.PUBLIC_URL).origin,
    ...(config.NODE_ENV === "development" ? ["http://localhost:5173"] : []),
  ]);
}

/**
 * The app API (`/api/app/*`) is private to our own web app: cookie session,
 * CSRF protection, free to change between versions. Documented in the
 * OpenAPI document so the web app can generate a typed client.
 */
export function createAppRouter(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook<AppEnv>() });
  const origins = allowedOrigins(deps.config);

  // CSRF: cookies ride along on cross-site requests, so every state-changing
  // request must come from our own origin and be JSON (a plain HTML form can't send it).
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    if (c.req.method !== "DELETE" && !c.req.header("content-type")?.startsWith("application/json")) {
      return apiError(c, 415, "unsupported_media_type", "Send JSON");
    }
    return next();
  });
  return app;
}

/** Requires a signed-in person; exposes it as `c.get("user")`. */
export function requireSession(auth: Auth) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get("user")) return next();
    const user = await sessionUser(auth, c.req.raw.headers);
    if (!user) return apiError(c, 401, "unauthorized", "Sign in to continue");
    c.set("user", user);
    await next();
  });
}

// ── Shared OpenAPI pieces ─────────────────────────────────────────────────────

export const security = [{ session: [] }];
export const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Not signed in"),
  403: errorResponse("Not allowed"),
  404: errorResponse("Not found"),
  409: errorResponse("Conflict"),
};
export const json = <T extends z.ZodType>(schema: T, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
export const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { "application/json": { schema } },
});
export const OrgParams = z.object({ orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }) });
export const noContent = { 204: { description: "Done" } };

export const iso = (d: Date | null) => (d ? d.toISOString() : null);
