import { BILLING_FROM, mintBillingLink } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Billing"];

/**
 * The workspace's way to the billing service (ADR 0071): this server knows no plan, price or currency, only a
 * link that opens the service signed in as the person asking.
 */
export function billingRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/billing-link",
      tags,
      security,
      summary: "A signed link to the workspace's plan and billing (owners and admins)",
      description:
        "Opens the billing service signed in as you, for 5 minutes and once. Allowed on hold (paying is how a billing hold ends), refused while suspended. 404 `billing.off` when this server has no billing service.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            from: z
              .enum(BILLING_FROM)
              .openapi({ description: "Where in the app it was opened: the billing service opens on that." }),
          }),
        ),
      },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errors },
    }),
    async (c) => {
      if (!config.BILLING_URL || !config.BILLING_LINK_SECRET)
        return apiError(c, 404, "billing.off", "This server has no billing service");
      const link = await mintBillingLink(db, {
        secret: config.BILLING_LINK_SECRET,
        baseUrl: config.BILLING_URL,
        userId: c.get("user").id,
        orgId: c.req.valid("param").orgId,
        from: c.req.valid("json").from,
      });
      return c.json({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 200);
    },
  );

  return app;
}
