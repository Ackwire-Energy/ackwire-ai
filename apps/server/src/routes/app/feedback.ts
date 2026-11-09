import { FEEDBACK_MAX, getMembership, NotFoundError, queueFeedback, TooManyError } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { version } from "../../version";
import { type AppDeps, body, createAppRouter, errors, noContent, requireSession, security } from "./context";

const tags = ["System"];

/** More than anyone writes by hand in an hour, too few to flood whoever reads them. */
const FEEDBACK_PER_HOUR = { limit: 10, windowMs: 60 * 60_000 };

/**
 * The apps' feedback form (ADR 0160): what the person wrote goes by email to whoever runs the server
 * (`FEEDBACK_EMAIL`), through the outbox. Without that address there is no form and no route.
 */
export function feedbackRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/feedback", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/feedback",
      tags,
      summary: "Send feedback to whoever runs this server",
      description:
        "One email to `FEEDBACK_EMAIL` with the text, the person's name and address (to answer them), the workspace's name when `orgId` is one of theirs, and this server's version. 404 when the server takes no feedback (`auth-config.feedback` is false), 429 past ten an hour.",
      security,
      request: {
        body: body(
          z.object({
            id: z.uuid().openapi({ description: "Made by the app for this message: sent again, it goes once." }),
            text: z.string().trim().min(1).max(FEEDBACK_MAX),
            orgId: z.uuid().optional().openapi({ description: "The workspace the person was in." }),
            where: z.string().max(200).optional().openapi({ description: "The screen they were on (a path)." }),
            app: z.string().max(60).optional().openapi({ description: "The app that sent it, e.g. `web`." }),
          }),
        ),
      },
      responses: { ...noContent, 400: errors[400], 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const to = config.FEEDBACK_EMAIL;
      if (!to) throw new NotFoundError("Not found");
      const user = c.get("user");
      const input = c.req.valid("json");
      if (!(await deps.adapters.rateLimiter.consume(`feedback:${user.id}`, FEEDBACK_PER_HOUR)).allowed)
        throw new TooManyError("Too much feedback for now");
      // Only a workspace of theirs is named: an id from anywhere else says nothing.
      const member = input.orgId ? await getMembership(db, user.id, input.orgId) : null;
      await queueFeedback(db, {
        orgId: member?.orgId ?? null,
        key: `${user.id}:${input.id}`,
        feedback: {
          to,
          name: user.name,
          email: user.email,
          orgName: member?.orgName,
          text: input.text,
          where: input.where,
          app: input.app,
          version,
        },
      });
      deps.wakeWorkers?.();
      return c.body(null, 204);
    },
  );

  return app;
}
