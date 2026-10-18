import { ComposioSignatureError } from "@agenteschat/adapters";
import {
  createWebhookEndpoint,
  ForbiddenSignatureError,
  handleComposioWebhook,
  handleWebhook,
  NotFoundError,
  ValidationError,
  WEBHOOK_PROVIDERS,
  type WebhookProvider,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./app/context";

/**
 * Incoming webhooks: `POST /api/webhooks/{provider}/{endpointId}` (public,
 * signature-checked; no session), and the admin endpoint that creates one.
 */
export function registerWebhookReceiver(api: OpenAPIHono, deps: AppDeps) {
  const webhookDeps = { db: deps.db, keyWrappers: [deps.adapters.keyWrapper, ...deps.adapters.legacyKeyWrappers] };
  // Composio (ADR 0038): new mail for routines, expired accounts. One endpoint for the whole server,
  // signed with the subscription's secret (checked by the Composio client). Before the generic route.
  api.post("/webhooks/composio", async (c) => {
    const raw = await c.req.text();
    if (raw.length > 1_000_000) return c.json({ error: "too large" }, 413);
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
    const raw = await c.req.text();
    if (raw.length > 1_000_000) return c.json({ error: "too large" }, 413);
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
