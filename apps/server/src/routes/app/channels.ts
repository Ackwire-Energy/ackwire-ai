import {
  archiveChannel,
  channelMembersDetail,
  removeChannelMember,
  requireChannelAccess,
  updateChannel,
} from "@agenteschat/engine";
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
import { Channel } from "./schemas";

const tags = ["Channels"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

/** Channel management beyond chat (`chat.ts`): membership removal; open subscriptions are revoked at once. */
export function channelRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const opts = { pubsub: adapters.pubsub };

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/leave",
      tags,
      security,
      summary: "Leave a channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const userId = c.get("user").id;
      await removeChannelMember(db, userId, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/people/{userId}",
      tags,
      security,
      summary: "Remove a person from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ userId: z.string() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, userId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { userId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}/members/agents/{agentId}",
      tags,
      security,
      summary: "Remove an agent from a channel (creator or admin)",
      request: { params: ChannelParams.extend({ agentId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId, agentId } = c.req.valid("param");
      await removeChannelMember(db, c.get("user").id, orgId, channelId, { agentId }, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/channels/{channelId}",
      tags,
      security,
      summary: "Archive a channel (creator or admin)",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await archiveChannel(db, c.get("user").id, orgId, channelId, opts);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/channels/{channelId}",
      tags,
      security,
      summary: "Rename, change topic or visibility (creator or admin)",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80).optional(),
            topic: z.string().max(500).optional(),
            visibility: z.enum(["public", "private"]).optional(),
          }),
        ),
      },
      responses: { 200: json(Channel), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const r = await updateChannel(db, c.get("user").id, orgId, channelId, c.req.valid("json"));
      return c.json(
        {
          id: r.id,
          name: r.name,
          topic: r.topic,
          visibility: r.visibility,
          isMember: true,
          createdAt: r.createdAt.toISOString(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/roster",
      tags,
      security,
      summary: "Channel members with names (people and agents)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            members: z.array(
              z.object({
                type: z.enum(["person", "agent"]),
                id: z.string(),
                name: z.string(),
                handle: z.string().nullable(),
                autoReply: z.boolean().nullable().openapi({ description: "Agents: answers without a mention here." }),
                joinedAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const rows = await channelMembersDetail(db, orgId, channelId);
      return c.json(
        {
          members: rows.map((m) =>
            m.agentId
              ? {
                  type: "agent" as const,
                  id: m.agentId,
                  name: m.agentName ?? "",
                  handle: m.agentHandle,
                  autoReply: m.autoReply,
                  joinedAt: m.joinedAt.toISOString(),
                }
              : {
                  type: "person" as const,
                  id: m.userId ?? "",
                  name: m.userName ?? "",
                  handle: null,
                  autoReply: null,
                  joinedAt: m.joinedAt.toISOString(),
                },
          ),
        },
        200,
      );
    },
  );

  return app;
}
