import { listDms, markChannelRead, openDm } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Chat"];

const Dm = z
  .object({
    channelId: z.uuid().openapi({ description: "Use the channel message endpoints and WebSocket with this id." }),
    with: z.object({
      type: z.enum(["person", "agent"]),
      id: z.string(),
      name: z.string(),
      handle: z.string().nullable(),
    }),
    lastMessage: z.object({ id: z.uuid(), body: z.string(), createdAt: z.string(), authorType: z.string() }).nullable(),
    unread: z.number(),
  })
  .openapi("DirectMessage");

/** Direct conversations (person↔person, person↔agent). In an agent DM the agent answers every message. */
export function dmRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/dms",
      tags,
      security,
      summary: "My direct conversations, with unread counts",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ dms: z.array(Dm) })), ...errors },
    }),
    async (c) => {
      const dms = await listDms(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          dms: dms.map((d) => ({
            ...d,
            lastMessage: d.lastMessage ? { ...d.lastMessage, createdAt: d.lastMessage.createdAt.toISOString() } : null,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dms",
      tags,
      security,
      summary: "Open (or create) a direct conversation with a person or an agent",
      request: {
        params: OrgParams,
        body: body(z.union([z.object({ userId: z.string() }), z.object({ agentId: z.uuid() })])),
      },
      responses: { 200: json(z.object({ channelId: z.uuid() })), ...errors },
    }),
    async (c) => {
      const channel = await openDm(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json({ channelId: channel.id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/read",
      tags,
      security,
      summary: "Mark a channel or DM read up to now",
      request: { params: OrgParams.extend({ channelId: z.uuid() }), body: body(z.object({})) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await markChannelRead(db, c.get("user").id, orgId, channelId);
      return c.body(null, 204);
    },
  );

  return app;
}
