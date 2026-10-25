import { createInviteLink, requestNewInvitation } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { requestIp } from "../../http/client-ip";
import { apiError } from "../../http/errors";
import { type AppDeps, createAppRouter, errors, json, noContent, OrgParams, requireSession, security } from "./context";

const tags = ["Organizations"];

/** Org-wide invite links and "ask for a new invitation" from an expired one. */
export function inviteRoutes(deps: AppDeps) {
  const { db, config, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/invite-links",
      tags,
      security,
      summary: "Create an invite link: whoever joins with it becomes a member (7 days)",
      description: "Only a hash of the token is stored; the URL is shown once.",
      request: { params: OrgParams },
      responses: { 201: json(z.object({ url: z.string(), expiresAt: z.string() }), "Created"), ...errors },
    }),
    async (c) => {
      const { link, token } = await createInviteLink(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        { url: `${config.PUBLIC_URL.replace(/\/$/, "")}/invite/${token}`, expiresAt: link.expiresAt.toISOString() },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/invitations/{token}/request-new",
      tags,
      summary: "Ask whoever invited you for a new invitation (the old one expired)",
      request: { params: z.object({ token: z.string().min(1).max(200) }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const ip = requestIp(c.req.raw.headers);
      const limit = await adapters.rateLimiter.consume(`invite-request:${ip}`, { limit: 10, windowMs: 3600_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Too many requests; try again later");
      await requestNewInvitation({ db, pubsub: adapters.pubsub }, config.PUBLIC_URL, c.req.valid("param").token);
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  return app;
}
