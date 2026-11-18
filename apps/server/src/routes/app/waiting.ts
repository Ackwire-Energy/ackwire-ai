import { listWaiting, NOTIFICATION_KINDS } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";
import { NotificationSource } from "./notifications";

const WaitingItem = z
  .object({
    id: z.uuid().openapi({ description: "Its inbox row (`/notifications/{id}`): done, snooze and open act on it." }),
    kind: z.enum(NOTIFICATION_KINDS),
    asker: z.object({ type: z.enum(["user", "agent"]), id: z.string() }).nullable(),
    source: NotificationSource,
    question: z.string().openapi({ description: "What is asked, in one line." }),
    since: z.string(),
  })
  .openapi("WaitingItem");

/**
 * "Esperando você" (ADR 0172): what waits on the person in a workspace, oldest first. A view of the inbox's waiting
 * rows, so it changes with the same user events (`notification.upserted`, `notification.removed`,
 * `notification.counts`).
 */
export function waitingRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/waiting",
      tags: ["Notifications"],
      security,
      summary: "Everything waiting on me: questions, approvals and requests, oldest first (at most 100)",
      request: {
        params: OrgParams,
        query: z.object({
          channelId: z.uuid().optional().openapi({ description: "Only what was asked in this conversation." }),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(WaitingItem), count: z.number().int() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const waiting = await listWaiting(
        { db: deps.db, pubsub: deps.adapters.pubsub },
        c.get("user").id,
        orgId,
        c.req.valid("query"),
      );
      return c.json(waiting, 200);
    },
  );

  return app;
}
