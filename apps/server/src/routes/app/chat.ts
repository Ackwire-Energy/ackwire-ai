import {
  addChannelMember,
  createChannel,
  joinChannel,
  listChannelMembers,
  listChannels,
  listMessages,
  postPersonMessage,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
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
import { Channel, Message } from "./schemas";

const tags = ["Chat"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

/** Channels and messages. Real-time updates arrive over the WebSocket (`/api/ws`). */
export function chatRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary: "Public channels and the private ones you belong to",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ channels: z.array(Channel) })), ...errors },
    }),
    async (c) => {
      const rows = await listChannels(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          channels: rows.map((r) => ({
            id: r.id,
            name: r.name,
            topic: r.topic,
            visibility: r.visibility,
            isMember: r.isMember,
            createdAt: r.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary: "Create a channel (you join it)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80),
            topic: z.string().max(500).optional(),
            visibility: z.enum(["public", "private"]).optional(),
          }),
        ),
      },
      responses: { 201: json(Channel, "Created"), ...errors },
    }),
    async (c) => {
      const r = await createChannel(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(
        {
          id: r.id,
          name: r.name,
          topic: r.topic,
          visibility: r.visibility,
          isMember: true,
          createdAt: r.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/join",
      tags,
      security,
      summary: "Join a public channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await joinChannel(db, c.get("user").id, orgId, channelId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "People and agents in a channel",
      request: { params: ChannelParams },
      responses: {
        200: json(z.object({ members: z.array(z.object({ type: z.enum(["person", "agent"]), id: z.string() })) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json({ members: await listChannelMembers(db, c.get("user").id, orgId, channelId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "Add a person or an agent to a channel",
      request: {
        params: ChannelParams,
        body: body(z.union([z.object({ userId: z.string() }), z.object({ agentId: z.uuid() })])),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await addChannelMember(db, c.get("user").id, orgId, channelId, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Messages of a channel or of one thread",
      request: {
        params: ChannelParams,
        query: z.object({
          threadId: z.uuid().optional(),
          before: z.iso
            .datetime()
            .optional()
            .openapi({ description: "Page backwards from this time (top-level messages)." }),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: { 200: json(z.object({ messages: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const q = c.req.valid("query");
      const messages = await listMessages(db, c.get("user").id, orgId, channelId, {
        threadId: q.threadId,
        before: q.before ? new Date(q.before) : undefined,
        limit: q.limit,
      });
      return c.json({ messages }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Post a message",
      description:
        "@mentioning an agent that is a member of the channel starts an agent run; its reply streams over the WebSocket.",
      request: {
        params: ChannelParams,
        body: body(z.object({ body: z.string().min(1).max(40_000), threadId: z.uuid().nullable().optional() })),
      },
      responses: { 201: json(Message, "Created"), 429: errorResponse("Too many messages"), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const user = c.get("user");
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const message = await postPersonMessage(
        { db, pubsub: adapters.pubsub },
        user.id,
        orgId,
        channelId,
        c.req.valid("json"),
      );
      if (message.mentionedAgentIds.length > 0) deps.wakeWorkers?.();
      return c.json(message, 201);
    },
  );

  return app;
}
