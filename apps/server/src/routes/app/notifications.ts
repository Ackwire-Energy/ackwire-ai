import { SCREEN_KINDS } from "@agenteschat/adapters";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationDone,
  markNotificationRead,
  NOTIFICATION_FILTERS,
  NOTIFICATION_KINDS,
  notificationCounts,
  snoozeNotification,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { ApprovalOrigin } from "./approvals";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Notifications"];

const Actor = z.object({ type: z.enum(["user", "agent"]), id: z.string() });

const Notification = z
  .object({
    id: z.uuid(),
    kind: z.enum(NOTIFICATION_KINDS),
    waiting: z.boolean(),
    actors: z.array(Actor),
    count: z.number().int(),
    source: z.object({
      channelId: z.string().optional(),
      threadId: z.string().optional(),
      messageId: z.string().optional(),
      dmId: z.string().optional(),
      issueId: z.string().optional(),
      issueNumber: z.number().int().optional(),
      topicId: z.string().optional(),
      approvalId: z.string().optional(),
      questionId: z.string().optional(),
      missionId: z.string().optional(),
      routineId: z.string().optional(),
      machineId: z.string().optional(),
      handoffId: z.string().optional(),
      screen: z.enum(SCREEN_KINDS).optional(),
      agentId: z
        .string()
        .optional()
        .openapi({ description: "`org_standing` to `agent_hold`: the agent held (its name in `label`)." }),
      label: z.string().optional(),
    }),
    latest: z.object({
      text: z.string().optional(),
      title: z.string().optional(),
      emojis: z.array(z.string()).optional(),
      quote: z.string().optional(),
      statusFrom: z.string().optional(),
      statusTo: z.string().optional(),
      steps: z
        .object({ done: z.number().int(), total: z.number().int(), failedAt: z.number().int().optional() })
        .optional(),
      suggestions: z.array(z.string()).optional(),
      expiresAt: z.string().optional(),
      round: z.number().int().optional(),
      rounds: z.number().int().optional(),
      reason: z
        .string()
        .optional()
        .openapi({ description: "`routine_paused`: why it paused; `routine_failed`: its run's code (both coded)." }),
      origin: ApprovalOrigin.optional().openapi({
        description: "`approval`: asked while nobody watched, by a routine or by unattended work.",
      }),
      names: z
        .array(z.string())
        .optional()
        .openapi({ description: "`join_request`: the first two people who asked, in the order they asked." }),
      holdKind: z
        .string()
        .optional()
        .openapi({ description: "`org_standing` to `agent_hold`: `network` or `operator`, never the hold's reason." }),
    }),
    readAt: z.string().nullable(),
    doneAt: z.string().nullable(),
    snoozedUntil: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Notification");

const Filter = z.enum(NOTIFICATION_FILTERS);
const Counts = z.object({
  all: z.number().int(),
  mentions: z.number().int(),
  waiting: z.number().int(),
  unread: z.number().int(),
  reactions: z.number().int(),
});
const NotificationParams = OrgParams.extend({ notificationId: z.uuid() });

/**
 * The person's inbox: mentions, thread replies, DMs, agents' questions,
 * issues, forum turns, approvals, missions, routines, reactions. Live
 * updates arrive on the WebSocket as user events (`notification.upserted`,
 * `notification.removed`, `notification.counts`).
 */
export function notificationRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const nd = { db, pubsub: adapters.pubsub };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/notifications",
      tags,
      security,
      summary: "The inbox: waiting first, then newest; counts per filter (done and snoozed left out)",
      request: {
        params: OrgParams,
        query: z.object({
          filter: Filter.optional(),
          cursor: z.string().max(400).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
      responses: {
        200: json(z.object({ items: z.array(Notification), counts: Counts, nextCursor: z.string().nullable() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const q = c.req.valid("query");
      return c.json(await listNotifications(nd, c.get("user").id, orgId, q), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/notifications/count",
      tags,
      security,
      summary: "Unread and waiting (the sidebar badge)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ unread: z.number().int(), waiting: z.number().int() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await notificationCounts(nd, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/notifications/read-all",
      tags,
      security,
      summary: "Mark everything (in a filter) read; returns the ids changed, for the undo",
      request: { params: OrgParams, body: body(z.object({ filter: Filter.optional() })) },
      responses: { 200: json(z.object({ ids: z.array(z.uuid()) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { filter } = c.req.valid("json");
      return c.json(await markAllNotificationsRead(nd, c.get("user").id, orgId, filter), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/notifications/{notificationId}/read",
      tags,
      security,
      summary: "Mark one read or unread",
      request: { params: NotificationParams, body: body(z.object({ read: z.boolean() })) },
      responses: { 200: json(Notification), ...errors },
    }),
    async (c) => {
      const { orgId, notificationId } = c.req.valid("param");
      const { read } = c.req.valid("json");
      return c.json(await markNotificationRead(nd, c.get("user").id, orgId, notificationId, read), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/notifications/{notificationId}/done",
      tags,
      security,
      summary: "Done (out of the inbox), or undo it",
      request: { params: NotificationParams, body: body(z.object({ done: z.boolean() })) },
      responses: { 200: json(Notification), ...errors },
    }),
    async (c) => {
      const { orgId, notificationId } = c.req.valid("param");
      const { done } = c.req.valid("json");
      return c.json(await markNotificationDone(nd, c.get("user").id, orgId, notificationId, done), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/notifications/{notificationId}/snooze",
      tags,
      security,
      summary: "Hide it until a time (it comes back on top); `until: null` undoes it",
      request: {
        params: NotificationParams,
        body: body(z.object({ until: z.iso.datetime({ offset: true }).nullable() })),
      },
      responses: { 200: json(Notification), ...errors },
    }),
    async (c) => {
      const { orgId, notificationId } = c.req.valid("param");
      const { until } = c.req.valid("json");
      return c.json(
        await snoozeNotification(nd, c.get("user").id, orgId, notificationId, until === null ? null : new Date(until)),
        200,
      );
    },
  );

  return app;
}
