import { ComposioSignatureError } from "@agenteschat/adapters";
import {
  createWebhookEndpoint,
  ForbiddenSignatureError,
  HOOK_LIMIT_PER_IP,
  handleComposioWebhook,
  handleWebhook,
  NotFoundError,
  receiveRoutineHook,
  ValidationError,
  WEBHOOK_PROVIDERS,
  type WebhookProvider,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { requestLimitIp } from "../http/client-ip";
import { apiError } from "../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  OrgParams,
  requireSession,
  routineHookDeps,
  security,
} from "./app/context";
import { readWebhookBytes, readWebhookText } from "./webhook-body";

/** What a routine's address answers when it refuses a call (English: the caller is a program). */
const HOOK_REFUSALS = {
  not_found: "No routine is listening at this address",
  invalid_signature: "The signature doesn't match the routine's signing secret",
  too_large: "The body is larger than 256 KB",
  rate_limited: "Too many calls. Try again in a minute.",
} as const;

/**
 * Incoming webhooks: `POST /api/webhooks/{provider}/{endpointId}` (public,
 * signature-checked; no session), and the admin endpoint that creates one.
 */
export function registerWebhookReceiver(api: OpenAPIHono, deps: AppDeps) {
  const webhookDeps = { db: deps.db, keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers] };
  // Composio (ADR 0038): new mail for routines, expired accounts. One endpoint for the whole server,
  // signed with the subscription's secret (checked by the Composio client). Before the generic route.
  api.post("/webhooks/composio", async (c) => {
    const raw = await readWebhookText(c.req.raw, 1_000_000);
    if (raw === null) return c.json({ error: "too large" }, 413);
    try {
      const result = await handleComposioWebhook({ db: deps.db, mail: deps.adapters.mail }, c.req.raw.headers, raw);
      if (result.fired > 0) deps.wakeWorkers?.();
      return c.json({ ok: true, type: result.type, fired: result.fired }, 202);
    } catch (error) {
      if (error instanceof ComposioSignatureError) return c.json({ error: "invalid signature" }, 401);
      if (error instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      if (error instanceof SyntaxError) return c.json({ error: "invalid body" }, 400);
      throw error;
    }
  });
  api.post("/webhooks/:provider/:endpointId", async (c) => {
    const provider = c.req.param("provider") as WebhookProvider;
    if (!WEBHOOK_PROVIDERS.includes(provider)) return c.json({ error: "unknown provider" }, 404);
    const raw = await readWebhookText(c.req.raw, 1_000_000);
    if (raw === null) return c.json({ error: "too large" }, 413);
    try {
      const result = await handleWebhook(webhookDeps, provider, c.req.param("endpointId"), c.req.raw.headers, raw);
      if (result.fired > 0) deps.wakeWorkers?.();
      return c.json({ ok: true, event: result.event, fired: result.fired }, 202);
    } catch (error) {
      if (error instanceof ForbiddenSignatureError) return c.json({ error: "invalid signature" }, 401);
      if (error instanceof NotFoundError) return c.json({ error: "not found" }, 404);
      if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
}

/**
 * A routine's own address (ADR 0106): `POST /api/hooks/{token}`, no session, the token is the credential. Every
 * call counts against its client's address first, before anything is looked up.
 */
export function registerRoutineHooks(api: OpenAPIHono, deps: AppDeps) {
  const hookDeps = routineHookDeps(deps);
  api.post("/hooks/:token", async (c) => {
    const ip = requestLimitIp(c.req.raw.headers, deps.config.TRUSTED_PROXIES);
    if (!(await deps.adapters.rateLimiter.consume(`routine-hook-ip:${ip}`, HOOK_LIMIT_PER_IP)).allowed) {
      c.header("retry-after", "60");
      return apiError(c, 429, "rate_limited", HOOK_REFUSALS.rate_limited);
    }
    const answer = await receiveRoutineHook(hookDeps, {
      token: c.req.param("token"),
      headers: c.req.raw.headers,
      read: (max) => readWebhookBytes(c.req.raw, max),
    });
    if (answer.status !== 202) {
      if (answer.status === 429) c.header("retry-after", "60");
      return apiError(c, answer.status, answer.code, HOOK_REFUSALS[answer.code]);
    }
    if (!answer.duplicate) deps.wakeWorkers?.();
    return c.json({ ok: true as const, runId: answer.runId, ...(answer.duplicate ? { duplicate: true } : {}) }, 202);
  });
  api.on(["GET", "PUT", "PATCH", "DELETE"], "/hooks/:token", (c) => {
    c.header("allow", "POST");
    return apiError(c, 405, "method_not_allowed", "Call this address with POST");
  });
}

export function webhookAdminRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const webhookDeps = { db: deps.db, keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers] };
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/webhooks",
      tags: ["Routines"],
      security,
      summary: "Create an incoming webhook (GitHub, Sentry); the secret is shown once",
      request: { params: OrgParams, body: body(z.object({ provider: z.enum(["github", "sentry"]) })) },
      responses: {
        201: json(z.object({ id: z.uuid(), provider: z.string(), url: z.string(), secret: z.string() }), "Created"),
        ...errors,
      },
    }),
    async (c) => {
      const created = await createWebhookEndpoint(
        webhookDeps,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json").provider,
        deps.config.PUBLIC_URL,
      );
      return c.json(created, 201);
    },
  );
  return app;
}
