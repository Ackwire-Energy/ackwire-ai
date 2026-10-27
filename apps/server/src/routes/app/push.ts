import { EXPO_PUSH_TOKEN, PUSH_PLATFORMS, registerPushDevice, unregisterPushDevice } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, noContent, requireSession, security } from "./context";

const tags = ["Push"];

const Token = z
  .string()
  .regex(EXPO_PUSH_TOKEN, "must be an Expo push token")
  .openapi({ example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" });

/** The phone app's push devices (ADR 0035). Per person: one phone hears every organization of its person. */
export function pushRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/push/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/push/devices",
      tags,
      security,
      summary: "Register this phone for push notifications",
      description:
        "Upsert by token: registering a token again refreshes it, and a token registered by someone else moves to you. Call on every launch after sign-in.",
      request: {
        body: body(
          z.object({
            token: Token,
            platform: z.enum(PUSH_PLATFORMS),
            locale: z.string().trim().min(2).max(35).openapi({ description: "Device language, e.g. `pt-BR`." }),
          }),
        ),
      },
      responses: { 204: noContent[204], 429: errorResponse("Too many registrations"), ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const limit = await deps.adapters.rateLimiter.consume(`push:${user.id}`, { limit: 30, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many registrations. Try again later.");
      await registerPushDevice(db, user.id, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/push/devices/{token}",
      tags,
      security,
      summary: "Stop push notifications on this phone (sign-out)",
      description: "Only your own tokens; anything else is a no-op. URL-encode the token.",
      request: { params: z.object({ token: z.string().min(1).max(256) }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      await unregisterPushDevice(db, c.get("user").id, c.req.valid("param").token);
      return c.body(null, 204);
    },
  );

  return app;
}
